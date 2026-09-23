import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The Control Center's data.
//
// The thing being guarded against is a panel that looks authoritative and is
// assembled from somewhere other than the record. Every number here has to come
// from a durable row, estimate and actual have to stay apart, and a permission
// that was DENIED has to be as visible as one that was granted — "why can it
// not do this" is asked far more often than "what can it do".

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-control-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-control-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";
process.env.RAZEKIT_MODEL_NODE_COST = "1";

const { transact, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { advanceAgent, LOOP_STAGE } = await import("../src/autonomous-loop.js");
const { authorizeToolCall, APPROVAL_SCOPE } = await import("../src/permission-broker.js");
const { resolvePermissionAction } = await import("../src/user-actions.js");
const { appendInstructionVersion } = await import("../src/task-instructions.js");
const { taskControlCenter } = await import("../src/task-control.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask() {
  seq += 1;
  const tenantId = "tenant-control-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "control-user",
    taskType: "website",
    title: "Control " + seq,
    originalRequest: "Build a landing page",
    specification: "Build a landing page",
    requestedTools: ["filesystem", "deploy-web"],
    estimatedBudget: 12,
    maxBudget: 40,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    executionLevel: "mid",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      level: "mid",
      scopes: ["autonomous task execution"],
      toolScopes: ["workspace:read", "workspace:write"],
      neverPreauthorized: ["deployment:deploy", "database:write"],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({ id: id("ac"), taskId: task.id, text: "It exists", status: "pending" });
  });
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

function harness() {
  let implementations = 0;
  const registry = new ModelAdapterRegistry();
  registry.register("astra", {
    async generate(request) {
      if (request.role === "planner") {
        return { output: "planned", architecture: { summary: "a page", steps: [] }, usage: { cost: 0.03 } };
      }
      return { output: "reviewed", review: { decision: "pass", reason: "fine", findings: [] }, usage: { cost: 0.01 } };
    }
  });
  registry.register("fable", {
    async generate() {
      implementations += 1;
      return {
        output: "implemented",
        implementation: { status: "implemented", filesChanged: 1 },
        plan: {
          id: "plan-" + implementations,
          version: 1,
          steps: [{ id: "write", kind: "workspace_write_file", path: "index.html", content: "<main>ok</main>" }]
        },
        usage: { cost: 0.08 }
      };
    }
  });
  return { registry, orchestrator: new ModelOrchestrator({ registry }) };
}

async function run(agentId, orchestrator, { maxTransitions = 40 } = {}) {
  for (let i = 0; i < maxTransitions; i += 1) {
    const result = await advanceAgent(agentId, { orchestrator });
    if ([LOOP_STAGE.COMPLETED, LOOP_STAGE.BLOCKED].includes(result.stage)) return result;
    if (result.stage === LOOP_STAGE.IDLE && !result.retryable) return result;
  }
  throw new Error("did not settle");
}

test("estimate and actual are reported separately, never as one figure", async () => {
  const { task, agent, tenantId } = await makeTask();
  await run(agent.id, harness().orchestrator);

  const view = await taskControlCenter({ taskId: task.id, tenantId });

  assert.equal(view.budget.limit, 40);
  assert.equal(view.budget.estimated, 12);
  assert.ok(view.budget.spent > 0, "nothing was recorded as spent");
  // The two are far apart, which is the whole point: a reservation is a
  // ceiling, and the difference between it and the actual is the budget doing
  // its job rather than a rounding error.
  assert.notEqual(view.budget.spent, view.budget.estimated);

  const priced = view.budget.perNode.filter(node => node.reserved > 0 && node.actual !== null);
  assert.ok(priced.length >= 3, "the model nodes did not report a per-node cost");
  for (const node of priced) {
    assert.ok(node.reserved >= node.actual, node.key + " spent more than it held");
    assert.equal(
      node.released, Number((node.reserved - node.actual).toFixed(2)),
      node.key + " did not account for what it gave back"
    );
  }

  // Nothing is left committed once the task is finished.
  assert.equal(view.budget.held, 0, "budget was still held after the task completed");
  assert.equal(view.budget.reservations.filter(item => item.status === "reserved").length, 0);
});

test("permissions show what was refused as prominently as what was granted", async () => {
  const { task, agent, tenantId } = await makeTask();

  // One request the user declines, one they allow once.
  const declined = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);
  await resolvePermissionAction({
    requestId: declined.permissionRequest.id, approve: false, reason: "not yet", actedBy: "user:test"
  });

  const allowed = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);
  await resolvePermissionAction({
    requestId: allowed.permissionRequest.id, approve: true, scope: APPROVAL_SCOPE.ONCE, actedBy: "user:test"
  });

  const view = await taskControlCenter({ taskId: task.id, tenantId });

  assert.deepEqual(view.permissions.authorized, ["workspace:read", "workspace:write"]);
  assert.ok(view.permissions.neverPreauthorized.includes("deployment:deploy"));
  assert.equal(view.permissions.executionLevel, "mid");

  assert.equal(view.permissions.denied.length, 1, "a declined request vanished from the record");
  assert.equal(view.permissions.denied[0].reason, "not yet");
  assert.equal(view.permissions.approved.length, 1);

  // A narrow grant shows how much of it is left, so "allow once" does not look
  // the same as "allowed".
  assert.equal(view.permissions.scopedGrants.length, 1);
  assert.equal(view.permissions.scopedGrants[0].scope, APPROVAL_SCOPE.ONCE);
  assert.equal(view.permissions.scopedGrants[0].usesRemaining, 1);
});

test("every instruction version is readable, not just the newest", async () => {
  const { task, agent, tenantId } = await makeTask();
  await appendInstructionVersion({ taskId: task.id, addition: "Also add a contact form", reason: "user change" });

  const view = await taskControlCenter({ taskId: task.id, tenantId });

  assert.equal(view.instructions.length, 2);
  assert.equal(view.instructions[0].version, 1);
  assert.equal(view.instructions[0].text, "Build a landing page");
  assert.match(view.instructions[1].text, /contact form/);
  assert.equal(view.overview.instructionVersion, 2);
  assert.ok(agent);
});

test("the overview names the phase from what is actually running", async () => {
  const { task, agent, tenantId } = await makeTask();
  const h = harness();

  // One transition: the graph exists but nothing has run yet.
  await advanceAgent(agent.id, { orchestrator: h.orchestrator });
  const early = await taskControlCenter({ taskId: task.id, tenantId });
  assert.equal(early.overview.executionCycles, 0);
  assert.ok(early.graph, "the control view had no graph");

  await run(agent.id, h.orchestrator);
  const done = await taskControlCenter({ taskId: task.id, tenantId });

  assert.equal(done.overview.currentPhase, "Complete");
  assert.equal(done.overview.currentNode, null);
  assert.equal(done.overview.executionCycles, 1);
  assert.equal(done.graph.status, "succeeded");
});

test("activity comes from the audit trail rather than a second account of events", async () => {
  const { task, agent, tenantId } = await makeTask();
  await run(agent.id, harness().orchestrator);

  const view = await taskControlCenter({ taskId: task.id, tenantId });

  assert.ok(view.activity.length > 0, "nothing was recorded");
  // Newest first, and every entry is a real audit action.
  for (const entry of view.activity) {
    assert.ok(entry.action, "an activity entry had no action");
    assert.ok(entry.at);
  }
  const actions = view.activity.map(entry => entry.action);
  assert.ok(
    actions.some(action => action.startsWith("graph.")),
    "the graph's own audit records are missing: " + [...new Set(actions)].join(", ")
  );
});

test("a task belonging to another tenant is not readable", async () => {
  const { task } = await makeTask();
  assert.equal(await taskControlCenter({ taskId: task.id, tenantId: "someone-else" }), null);
});
