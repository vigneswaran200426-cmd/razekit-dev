import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Prediction is not authorization.
//
// That sentence is the whole phase. The system used to collapse the two: one
// boolean — "I accept autonomous execution" — granted every scope a heuristic
// had guessed the task might want, including scopes that reach outside the
// workspace entirely. The user agreed to a sentence and the record said they
// had agreed to a tool list.
//
// These tests assert the separation from both directions: that a prediction
// grants nothing, and that an authorization cannot exist without a confirmation
// of something the user was actually shown.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-lifecycle-data-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_STORE = "json";

const { loadDb } = await import("../src/store.js");
const {
  EXECUTION_LEVELS,
  NEVER_PREAUTHORIZED_SCOPES,
  authorizeFromPreview,
  createTaskPreview,
  estimateTaskBudget,
  executionLevels,
  getTaskPreview,
  markPreviewConfirmed,
  narrowPreauthorizedScopes,
  predictTaskRequirements,
  validateCustomPolicy
} = await import("../src/task-lifecycle.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const DEPLOY_DRAFT = {
  taskType: "website",
  title: "Storefront",
  originalRequest: "Build a storefront with a Postgres database and deploy it to production",
  specification: "Build a storefront with a Postgres database and deploy it to production"
};

const PLAIN_DRAFT = {
  taskType: "website",
  title: "Landing page",
  originalRequest: "Build a one-page landing site",
  specification: "Build a one-page landing site"
};

test("a preview creates no task, no agent and no permission", async () => {
  const before = await loadDb();
  const taskCount = before.tasks.length;
  const agentCount = before.agentInstances.length;
  const permissionCount = before.toolPermissions.length;

  const { ok, preview } = await createTaskPreview(DEPLOY_DRAFT, {
    level: EXECUTION_LEVELS.HIGH,
    tenantId: "t-preview",
    userId: "u-preview"
  });
  assert.equal(ok, true);

  const after = await loadDb();
  assert.equal(after.tasks.length, taskCount, "a preview created a task");
  assert.equal(after.agentInstances.length, agentCount, "a preview spawned an agent");
  assert.equal(after.toolPermissions.length, permissionCount, "a preview granted a permission");

  // And it says so about itself.
  assert.equal(preview.prediction.isPrediction, true);
  assert.equal(preview.authorizationPreview.grantsNothing, true);
});

test("no execution level pre-authorizes a deployment or a data write", async () => {
  for (const level of [EXECUTION_LEVELS.LOW, EXECUTION_LEVELS.MID, EXECUTION_LEVELS.HIGH]) {
    const { preview } = await createTaskPreview(DEPLOY_DRAFT, { level, tenantId: "t-level", userId: "u" });
    for (const scope of NEVER_PREAUTHORIZED_SCOPES) {
      assert.ok(
        !preview.authorizationPreview.preauthorizedScopes.includes(scope),
        level + " pre-authorized " + scope
      );
    }
  }

  // The task genuinely needs them — which is why they show up as things it will
  // stop and ask for rather than simply being absent.
  const { preview } = await createTaskPreview(DEPLOY_DRAFT, {
    level: EXECUTION_LEVELS.HIGH, tenantId: "t-level2", userId: "u"
  });
  assert.ok(preview.authorizationPreview.willAskFor.includes("deployment:deploy"));
  assert.ok(preview.prediction.tools.includes("deploy-web"));
});

test("a higher level is a wider envelope, not a better one", () => {
  const levels = executionLevels();
  const low = levels.find(l => l.key === EXECUTION_LEVELS.LOW);
  const high = levels.find(l => l.key === EXECUTION_LEVELS.HIGH);

  assert.ok(high.preauthorizedScopes.length > low.preauthorizedScopes.length);
  // Every level names what it still stops for, so the list cannot be read as
  // "pick the top one to stop being interrupted".
  for (const level of levels) {
    assert.deepEqual(level.alwaysAsks, [...NEVER_PREAUTHORIZED_SCOPES]);
  }
});

test("an authorization requires a confirmation that matches what was shown", async () => {
  const { preview } = await createTaskPreview(PLAIN_DRAFT, {
    level: EXECUTION_LEVELS.MID, tenantId: "t-confirm", userId: "u-confirm"
  });

  // Wrong fingerprint: the task changed after the user read it.
  const tampered = await authorizeFromPreview({
    previewId: preview.id,
    fingerprint: "0".repeat(32),
    acceptAutonomousExecution: true,
    maxBudget: 50,
    tenantId: "t-confirm"
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.errors.join(" "), /changed after it was shown/i);

  // No explicit acceptance.
  const unaccepted = await authorizeFromPreview({
    previewId: preview.id,
    fingerprint: preview.fingerprint,
    acceptAutonomousExecution: undefined,
    maxBudget: 50,
    tenantId: "t-confirm"
  });
  assert.equal(unaccepted.ok, false);
  assert.match(unaccepted.errors.join(" "), /accepted explicitly/i);

  // No ceiling.
  const unbudgeted = await authorizeFromPreview({
    previewId: preview.id,
    fingerprint: preview.fingerprint,
    acceptAutonomousExecution: true,
    maxBudget: 0,
    tenantId: "t-confirm"
  });
  assert.equal(unbudgeted.ok, false);
  assert.match(unbudgeted.errors.join(" "), /budget ceiling/i);

  // All three present: authorized, and only to what the preview showed.
  const granted = await authorizeFromPreview({
    previewId: preview.id,
    fingerprint: preview.fingerprint,
    acceptAutonomousExecution: true,
    maxBudget: 50,
    tenantId: "t-confirm",
    userId: "u-confirm"
  });
  assert.equal(granted.ok, true);
  assert.deepEqual(
    granted.authorization.toolScopes,
    preview.authorizationPreview.preauthorizedScopes
  );
  assert.equal(granted.authorization.previewFingerprint, preview.fingerprint);
  assert.equal(granted.authorization.authorizedBy, "u-confirm");
});

test("a preview belonging to another tenant is not visible or usable", async () => {
  const { preview } = await createTaskPreview(PLAIN_DRAFT, {
    level: EXECUTION_LEVELS.MID, tenantId: "t-owner", userId: "u"
  });

  assert.equal(await getTaskPreview(preview.id, { tenantId: "t-intruder" }), null);

  const stolen = await authorizeFromPreview({
    previewId: preview.id,
    fingerprint: preview.fingerprint,
    acceptAutonomousExecution: true,
    maxBudget: 50,
    tenantId: "t-intruder"
  });
  assert.equal(stolen.ok, false);
});

test("one agreement starts one task", async () => {
  const { preview } = await createTaskPreview(PLAIN_DRAFT, {
    level: EXECUTION_LEVELS.MID, tenantId: "t-once", userId: "u"
  });

  const first = await authorizeFromPreview({
    previewId: preview.id, fingerprint: preview.fingerprint,
    acceptAutonomousExecution: true, maxBudget: 50, tenantId: "t-once"
  });
  assert.equal(first.ok, true);
  await markPreviewConfirmed(preview.id, "task_first");

  const second = await authorizeFromPreview({
    previewId: preview.id, fingerprint: preview.fingerprint,
    acceptAutonomousExecution: true, maxBudget: 50, tenantId: "t-once"
  });
  assert.equal(second.ok, false);
  assert.match(second.errors.join(" "), /already been used/i);
});

test("a ceiling below the estimate is allowed and said out loud", async () => {
  const { preview } = await createTaskPreview(PLAIN_DRAFT, {
    level: EXECUTION_LEVELS.MID, tenantId: "t-warn", userId: "u"
  });

  const result = await authorizeFromPreview({
    previewId: preview.id, fingerprint: preview.fingerprint,
    acceptAutonomousExecution: true,
    maxBudget: 1,
    tenantId: "t-warn"
  });

  // It is the user's money and their ceiling — but a task that stops half-built
  // for want of budget should not be a surprise.
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /may stop part-way/i);
});

test("a custom policy is validated as a whole, never partially accepted", () => {
  const bad = validateCustomPolicy({
    tools: ["filesystem", "not-a-tool"],
    preauthorizedScopes: ["workspace:write", "deployment:deploy", "made:up"],
    maxConcurrentNodes: 99
  });

  assert.equal(bad.valid, false);
  assert.equal(bad.policy, null, "an invalid policy produced a usable policy anyway");
  const joined = bad.errors.join(" | ");
  assert.match(joined, /Unknown tool: not-a-tool/);
  assert.match(joined, /Unknown scope: made:up/);
  assert.match(joined, /deployment:deploy.*cannot be pre-authorized/);
  assert.match(joined, /maxConcurrentNodes/);

  const good = validateCustomPolicy({
    tools: ["filesystem", "git"],
    preauthorizedScopes: ["workspace:read", "workspace:write", "git:read"],
    maxConcurrentNodes: 2,
    maxRepairCycles: 1
  });
  assert.equal(good.valid, true);
  assert.deepEqual(good.policy.preauthorizedScopes, ["git:read", "workspace:read", "workspace:write"]);
});

test("a scope no selected tool can reach is refused rather than recorded", () => {
  const narrowed = narrowPreauthorizedScopes(
    ["workspace:write", "engine:build", "deployment:deploy"],
    ["filesystem"]
  );

  assert.deepEqual(narrowed.granted, ["workspace:write"]);
  const refusedScopes = narrowed.refused.map(item => item.scope).sort();
  assert.deepEqual(refusedScopes, ["deployment:deploy", "engine:build"]);
  // Refusals are explained, because a silently dropped scope leaves the user
  // believing the task can do something it cannot.
  assert.ok(narrowed.refused.every(item => item.reason));
});

test("the budget is a range with a stated confidence, not a price", () => {
  const budget = estimateTaskBudget(PLAIN_DRAFT, { level: EXECUTION_LEVELS.MID });

  assert.ok(budget.minimum < budget.expected);
  assert.ok(budget.expected < budget.maximum);
  assert.ok(budget.confidence > 0 && budget.confidence < 1, "confidence was reported as certainty");
  assert.ok(budget.basis.length > 0);

  // A wider envelope costs more to allow for, and says so before the task runs.
  const high = estimateTaskBudget(PLAIN_DRAFT, { level: EXECUTION_LEVELS.HIGH });
  assert.ok(high.expected > budget.expected);
});

test("prediction reads the request rather than calling a model", () => {
  // This runs before the user has agreed to spend anything. Asking a paid model
  // what a task might cost is a charge for an estimate.
  const prediction = predictTaskRequirements(DEPLOY_DRAFT);

  assert.ok(prediction.tools.includes("database"));
  assert.ok(prediction.tools.includes("deploy-web"));
  assert.ok(prediction.externalServices.includes("hosting"));
  assert.ok(prediction.risks.some(risk => /reaches real users/i.test(risk)));
  assert.equal(prediction.resources.workspace, "isolated");
});
