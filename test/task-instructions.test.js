import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// What the task was asked to do, over time.
//
// The behaviour being replaced was one line:
//
//   task.specification = [task.specification, "User change: " + content].join("\n\n")
//
// After three changes that field answers none of the questions anyone actually
// asks of it — what did the user originally want, what was this build
// authorized against, when did the scope grow. These tests assert that history
// is kept rather than flattened, and that an approved change says what it will
// cost in permissions as well as in money.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-instr-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-instr-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { submitUserCommand, approveChange } = await import("../src/dashboard.js");
const {
  analyzeChangeImpact,
  appendInstructionVersion,
  currentInstruction,
  instructionHistory
} = await import("../src/task-instructions.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask({ specification = "Build a one-page landing site" } = {}) {
  seq += 1;
  const tenantId = "tenant-instr-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "instr-user",
    taskType: "website",
    title: "Instructions " + seq,
    originalRequest: specification,
    specification,
    requestedTools: ["filesystem", "node"],
    estimatedBudget: 5,
    maxBudget: 100,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes: ["workspace:read", "workspace:write", "process:execute"],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => db.tasks.push(task));
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

test("the original instruction is version one, and is never edited", async () => {
  const { task } = await makeTask({ specification: "Build a one-page landing site" });

  const v1 = await currentInstruction(task.id);
  assert.equal(v1.version, 1);
  assert.equal(v1.text, "Build a one-page landing site");
  assert.equal(v1.supersedes, null);

  await appendInstructionVersion({ taskId: task.id, addition: "Also add a contact form" });
  await appendInstructionVersion({ taskId: task.id, addition: "Also make it dark" });

  const history = await instructionHistory(task.id);
  assert.equal(history.length, 3);
  // The whole point: version one still says exactly what it said.
  assert.equal(history[0].text, "Build a one-page landing site");
  assert.equal(history[0].version, 1);
  assert.equal(history[1].supersedes, history[0].id);
  assert.equal(history[2].supersedes, history[1].id);

  const current = await currentInstruction(task.id);
  assert.equal(current.version, 3);
  assert.match(current.text, /landing site/);
  assert.match(current.text, /contact form/);
  assert.match(current.text, /dark/);
});

test("a task created before versions existed gets a version one from what it has", async () => {
  const { task } = await makeTask({ specification: "Legacy task text" });

  const db = await loadDb();
  assert.equal(
    db.taskInstructions.filter(item => item.taskId === task.id).length, 0,
    "the fixture already had versions, so this proves nothing"
  );

  const v1 = await currentInstruction(task.id);
  assert.equal(v1.version, 1);
  assert.equal(v1.text, "Legacy task text");
  assert.equal(v1.reason, "original request");
});

test("approving a change records a version instead of rewriting the specification", async () => {
  const { task } = await makeTask({ specification: "Build a landing site" });

  const submitted = await submitUserCommand(task.id, "Switch the payment provider to UroPay");
  assert.ok(submitted.change, "this change should have required approval");

  const approved = await approveChange(task.id, submitted.change.id, { maxBudget: 100 });
  assert.equal(approved.instruction.version, 2);
  assert.equal(approved.instruction.changeId, submitted.change.id);

  const history = await instructionHistory(task.id);
  assert.equal(history.length, 2);
  // Version one is intact: this is the assertion the old implementation failed.
  assert.equal(history[0].text, "Build a landing site");
  assert.match(history[1].text, /UroPay/);
  assert.equal(history[1].supersedes, history[0].id);
});

test("an impact analysis names the permissions a change would need, not just the cost", async () => {
  const { task } = await makeTask({ specification: "Build a static landing site" });

  const impact = await analyzeChangeImpact({
    taskId: task.id,
    content: "Store signups in a Postgres database and deploy it to production"
  });

  assert.equal(impact.isPrediction, true);
  assert.equal(impact.requirements.currentVersion, 1);
  assert.equal(impact.requirements.nextVersion, 2);

  // The part that used to be invisible: this change needs tools the task was
  // never authorized for.
  assert.ok(impact.permissions.newTools.includes("database"));
  assert.ok(impact.permissions.newTools.includes("deploy-web"));
  assert.ok(impact.permissions.wouldNeedApproval.includes("deployment:deploy"));
  assert.ok(impact.permissions.neverPreauthorized.includes("deployment:deploy"));

  // And the budget, separately, because they are separate decisions.
  assert.equal(impact.budget.limit, 100);
  assert.ok(impact.budget.remaining <= 100);
  assert.ok(impact.risks.length > 0);
});

test("a change that needs nothing new says so", async () => {
  const { task } = await makeTask({ specification: "Build a static landing site" });

  const impact = await analyzeChangeImpact({
    taskId: task.id,
    content: "Change the heading to say Welcome"
  });

  assert.deepEqual(impact.permissions.newTools, []);
  assert.deepEqual(impact.permissions.wouldNeedApproval, []);
  assert.deepEqual(impact.risks, []);
});
