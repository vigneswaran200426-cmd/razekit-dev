import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The LIVE loop, on the model graph.
//
// The previous phase proved model nodes work when a test driver claims them.
// That is not the same claim as "the autonomous loop runs them", and the
// difference matters: a graph nothing drives is a graph that never executes in
// production. Everything here goes through advanceAgent — the same entry point
// the coordinator and the operator endpoint call — and asserts on durable state
// afterwards rather than on anything the test arranged.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-live-loop-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-live-loop-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";
// Price the model nodes so reservations are real rather than zero-sized.
process.env.RAZEKIT_MODEL_NODE_COST = "1";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES, AGENT_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { advanceAgent, LOOP_STAGE } = await import("../src/autonomous-loop.js");
const { MODEL_NODE_KINDS } = await import("../src/jev-model-domain.js");
const { readBlackboard } = await import("../src/blackboard.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask({ maxBudget = 30 } = {}) {
  seq += 1;
  // A tenant per task: the hourly spend ceiling is per tenant, so tasks sharing
  // one would accumulate against each other and fail for the wrong reason.
  const tenantId = "tenant-live-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "live-user",
    taskType: "website",
    title: "Live loop " + seq,
    originalRequest: "Build a landing page",
    specification: "Build a landing page",
    requestedTools: ["filesystem", "node"],
    estimatedBudget: 1,
    maxBudget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes: [],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({
      id: id("ac"),
      taskId: task.id,
      text: "The page is written and the checks pass",
      status: "pending"
    });
  });
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

/** Drive advanceAgent exactly as the coordinator does: one transition a tick. */
async function runLoop(agentId, orchestrator, { maxTransitions = 40 } = {}) {
  const stages = [];
  for (let i = 0; i < maxTransitions; i += 1) {
    const result = await advanceAgent(agentId, { orchestrator });
    stages.push(result.stage);
    if ([LOOP_STAGE.COMPLETED, LOOP_STAGE.BLOCKED].includes(result.stage)) return { stages, result };
    if (result.stage === LOOP_STAGE.IDLE && !result.retryable) return { stages, result };
  }
  throw new Error("Loop did not settle. Stages: " + stages.join(" -> "));
}

const OK_PLAN_STEPS = [
  {
    id: "write-index",
    kind: "workspace_write_file",
    phase: "implementation",
    path: "index.html",
    content: "<main>built</main>"
  }
];

const FAILING_PLAN_STEPS = [
  ...OK_PLAN_STEPS,
  {
    id: "run-checks",
    kind: "command",
    phase: "test",
    executable: "node",
    args: ["-e", "process.exit(1)"],
    retries: 0,
    timeoutMs: 60000
  }
];

/**
 * A registry that records every provider call and, optionally, the state of the
 * ledger at the moment of the call.
 */
function registryFor({ reviewDecisions = ["pass"], steps = OK_PLAN_STEPS, onCall = null, implementError = null } = {}) {
  const calls = [];
  let reviewIndex = 0;
  let implementations = 0;

  const registry = new ModelAdapterRegistry();
  registry.register("astra", {
    async generate(request) {
      const snapshot = onCall ? await onCall(request) : null;
      calls.push({ role: request.role, snapshot });
      if (request.role === "planner") {
        return { output: "planned", architecture: { summary: "one page", steps: [] }, usage: { cost: 0.03 } };
      }
      const decision = reviewDecisions[Math.min(reviewIndex, reviewDecisions.length - 1)];
      reviewIndex += 1;
      return {
        output: "reviewed",
        review: { decision, reason: "decision " + decision, findings: [{ severity: "high", detail: "still wrong" }] },
        usage: { cost: 0.01 }
      };
    }
  });
  registry.register("fable", {
    async generate(request) {
      const snapshot = onCall ? await onCall(request) : null;
      calls.push({ role: request.role, snapshot });
      implementations += 1;
      if (implementError) throw implementError();
      return {
        output: "implemented",
        implementation: { status: "implemented", summary: "wrote the page", filesChanged: 1 },
        plan: { id: "fable-plan-" + implementations, version: 1, steps },
        usage: { cost: 0.08 }
      };
    }
  });

  return { registry, calls, orchestrator: new ModelOrchestrator({ registry }), get implementations() { return implementations; } };
}

test("advanceAgent runs every model phase as a graph node, reserving before each provider call", async () => {
  const { task, agent } = await makeTask();

  const harness = registryFor({
    onCall: async () => {
      // Observed from INSIDE the provider call: the only way to prove the
      // reservation existed before the money could be spent.
      const db = await loadDb();
      const held = db.billingReservations.filter(
        r => r.agentInstanceId === agent.id && r.status === "reserved"
      );
      return { heldCount: held.length, heldAmount: held.reduce((s, r) => s + Number(r.amount || 0), 0) };
    }
  });

  const { stages, result } = await runLoop(agent.id, harness.orchestrator);
  assert.equal(result.stage, LOOP_STAGE.COMPLETED, "stages: " + stages.join(" -> "));

  const db = await loadDb();
  const graph = db.taskGraphs.find(g => g.taskId === task.id);
  assert.ok(graph, "the live loop created a graph");
  const nodes = db.graphNodes.filter(n => n.graphId === graph.id);
  const kinds = nodes.map(n => n.kind);

  // Every model phase is an actual node that actually ran.
  for (const kind of [
    MODEL_NODE_KINDS.MODEL_PLAN,
    MODEL_NODE_KINDS.MODEL_IMPLEMENT,
    MODEL_NODE_KINDS.MODEL_REVIEW,
    MODEL_NODE_KINDS.MODEL_VERIFY
  ]) {
    const node = nodes.find(n => n.kind === kind);
    assert.ok(node, "no node of kind " + kind + "; kinds present: " + kinds.join(", "));
    assert.equal(node.status, "succeeded", kind + " did not succeed");
    assert.ok(Number(node.attempt) >= 1, kind + " never ran");
    assert.ok(node.leaseId, kind + " was never leased");
  }

  // The plan's own work ran as nodes too, downstream of the implementation.
  const execNode = nodes.find(n => n.key === "exec1:write-index");
  assert.ok(execNode && execNode.status === "succeeded", "the planned work did not run as a node");

  // Reservation preceded every provider call.
  assert.ok(harness.calls.length >= 4, "expected plan, implement, review and verify calls");
  for (const call of harness.calls) {
    assert.equal(call.snapshot.heldCount, 1, "no reservation was held during the " + call.role + " call");
    assert.ok(call.snapshot.heldAmount > 0, "the reservation held no budget (" + call.role + ")");
  }

  // Every reservation settled, and the spend the ledger recorded is the spend
  // the providers reported — not the much larger ceiling that was held.
  const reservations = db.billingReservations.filter(r => r.agentInstanceId === agent.id);
  assert.ok(reservations.length >= 4);
  assert.ok(reservations.every(r => r.status !== "reserved"), "a reservation was left open");

  const finalAgent = db.agentInstances.find(a => a.id === agent.id);
  assert.ok(Number(finalAgent.budgetUsed) > 0, "no spend was recorded at all");
  assert.ok(
    Number(finalAgent.budgetUsed) < reservations.reduce((s, r) => s + Number(r.amount || 0), 0),
    "the task was charged its reservations rather than its actual usage"
  );

  // The verification node interpreted a record that already existed.
  const verifyNode = nodes.find(n => n.kind === MODEL_NODE_KINDS.MODEL_VERIFY);
  assert.ok(verifyNode.payload?.evidence?.verificationId, "the verify node was given no evidence");
  assert.equal(verifyNode.payload.evidence.status, "passed");
  const verification = db.verificationRuns.find(v => v.id === verifyNode.payload.evidence.verificationId);
  assert.ok(verification, "the evidence does not refer to a real verification record");

  // And the orchestrator no longer schedules anything.
  const run = db.orchestrationRuns.find(r => r.agentInstanceId === agent.id);
  assert.equal(run.driver, "jev", "the run record was not produced by the graph driver");
});

test("a review that keeps asking for changes stops at the repair-cycle limit", async () => {
  const previous = process.env.RAZEKIT_MAX_REPAIR_CYCLES;
  process.env.RAZEKIT_MAX_REPAIR_CYCLES = "2";

  try {
    const { task, agent } = await makeTask();
    // Never satisfied. Without a ceiling this is an unbounded spend loop.
    const harness = registryFor({ reviewDecisions: ["revise"] });

    const { stages, result } = await runLoop(agent.id, harness.orchestrator, { maxTransitions: 60 });

    assert.equal(result.stage, LOOP_STAGE.BLOCKED, "stages: " + stages.join(" -> "));
    assert.match(result.reason, /repair cycles/i);
    assert.match(result.reason, /limit of 2/);

    const db = await loadDb();
    const graph = db.taskGraphs.find(g => g.taskId === task.id);
    const repairs = db.graphNodes.filter(n => n.graphId === graph.id && n.kind === MODEL_NODE_KINDS.MODEL_REPAIR);
    assert.equal(repairs.length, 1, "the limit did not bound how many repairs were created");

    const finalAgent = db.agentInstances.find(a => a.id === agent.id);
    assert.notEqual(finalAgent.status, AGENT_STATUS.COMPLETED);
    assert.equal(finalAgent.status, AGENT_STATUS.WAITING_USER);
  } finally {
    if (previous === undefined) delete process.env.RAZEKIT_MAX_REPAIR_CYCLES;
    else process.env.RAZEKIT_MAX_REPAIR_CYCLES = previous;
  }
});

test("a model call whose outcome is unknown stops the task instead of paying twice", async () => {
  const { agent } = await makeTask();

  let implementAttempts = 0;
  const harness = registryFor({
    implementError: () => {
      implementAttempts += 1;
      const error = new Error("socket hang up");
      // The adapter is the only layer that knows the request left the machine.
      error.transmitted = true;
      return error;
    }
  });

  const { stages, result } = await runLoop(agent.id, harness.orchestrator, { maxTransitions: 30 });

  assert.equal(result.stage, LOOP_STAGE.BLOCKED, "stages: " + stages.join(" -> "));
  assert.match(result.reason, /not known whether that call completed/i);

  // The point of the whole classification: it was NOT retried.
  assert.equal(implementAttempts, 1, "an unknown-outcome call was repeated at the provider's expense");

  const entries = await readBlackboard(agent.id);
  const pending = entries.find(e => e.key === "model.reconciliation.pending");
  assert.ok(pending, "nothing was recorded for an operator to reconcile");
  assert.equal(pending.value.kind, MODEL_NODE_KINDS.MODEL_IMPLEMENT);

  // The possible charge was kept, not released: treating a call that may have
  // been served as free is how a task quietly overspends.
  const db = await loadDb();
  const implementReservation = db.billingReservations
    .filter(r => r.agentInstanceId === agent.id)
    .find(r => String(r.reason || "").includes("fable-implement"));
  assert.ok(implementReservation, "the implementation never reserved");
  assert.equal(implementReservation.status, "captured");
});

test("a model review cannot complete a task that failed objective verification", async () => {
  const previous = process.env.RAZEKIT_MAX_REPAIR_CYCLES;
  // Zero repair cycles, so the failed verification has nowhere to go but back
  // to the user — which is what makes the assertion unambiguous.
  process.env.RAZEKIT_MAX_REPAIR_CYCLES = "0";

  try {
    const { agent } = await makeTask();
    // The reviewer says the work is fine. The build says otherwise.
    const harness = registryFor({ reviewDecisions: ["pass"], steps: FAILING_PLAN_STEPS });

    const { stages, result } = await runLoop(agent.id, harness.orchestrator, { maxTransitions: 40 });

    assert.equal(result.stage, LOOP_STAGE.BLOCKED, "stages: " + stages.join(" -> "));
    assert.match(result.reason, /did not pass verification/i);

    const db = await loadDb();
    const finalAgent = db.agentInstances.find(a => a.id === agent.id);
    assert.notEqual(finalAgent.status, AGENT_STATUS.COMPLETED, "a model verdict completed an unverified task");

    const verification = db.verificationRuns.filter(v => v.agentInstanceId === agent.id).pop();
    assert.equal(verification.status, "failed");
    assert.ok(verification.failures.length > 0);
  } finally {
    if (previous === undefined) delete process.env.RAZEKIT_MAX_REPAIR_CYCLES;
    else process.env.RAZEKIT_MAX_REPAIR_CYCLES = previous;
  }
});
