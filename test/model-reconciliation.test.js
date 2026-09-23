import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// What happens to a model call nobody knows the outcome of.
//
// The expensive mistake this guards is invisible: a provider that stops
// answering after the request was sent may have done the work and billed for
// it, so retrying spends the money twice and nothing in the system would say
// so. These tests assert the uncomfortable behaviour — the task stops, the
// possible charge is kept, and a durable record says what has to be settled —
// and that nothing is invented on the provider's behalf.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-recon-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-recon-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";
process.env.RAZEKIT_MODEL_NODE_COST = "1";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES, AGENT_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent, resumeAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { advanceAgent, LOOP_STAGE } = await import("../src/autonomous-loop.js");
const { MODEL_NODE_KINDS } = await import("../src/jev-model-domain.js");
const {
  RECONCILIATION_STATUS,
  attemptProviderReconciliation,
  pendingReconciliations,
  resolveReconciliation
} = await import("../src/model-reconciliation.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask() {
  seq += 1;
  const tenantId = "tenant-recon-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "recon-user",
    taskType: "website",
    title: "Reconciliation " + seq,
    originalRequest: "Build a landing page",
    specification: "Build a landing page",
    requestedTools: ["filesystem"],
    estimatedBudget: 1,
    maxBudget: 30,
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
    db.acceptanceCriteria.push({ id: id("ac"), taskId: task.id, text: "The page exists", status: "pending" });
  });
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent };
}

/**
 * @param failImplementUntil  the implementation call number up to and including
 *                            which the provider goes silent after transmitting.
 */
function harness({ failImplementUntil = 1, reconcile = undefined } = {}) {
  let implementCalls = 0;
  const seenKeys = [];

  const registry = new ModelAdapterRegistry();
  registry.register("astra", {
    async generate(request) {
      if (request.role === "planner") {
        return { output: "planned", architecture: { summary: "one page", steps: [] }, usage: { cost: 0.03 } };
      }
      return {
        output: "reviewed",
        review: { decision: "pass", reason: "fine", findings: [] },
        usage: { cost: 0.01 }
      };
    }
  });

  const fable = {
    async generate(request) {
      implementCalls += 1;
      seenKeys.push(request.idempotencyKey);
      if (implementCalls <= failImplementUntil) {
        const error = new Error("socket hang up");
        // Only the adapter knows the request left the machine.
        error.transmitted = true;
        throw error;
      }
      return {
        output: "implemented",
        implementation: { status: "implemented", filesChanged: 1 },
        plan: {
          id: "plan-" + implementCalls,
          version: 1,
          steps: [{ id: "write-index", kind: "workspace_write_file", path: "index.html", content: "<main>ok</main>" }]
        },
        usage: { cost: 0.08 }
      };
    }
  };
  if (reconcile) fable.reconcile = reconcile;
  registry.register("fable", fable);

  return {
    registry,
    orchestrator: new ModelOrchestrator({ registry }),
    seenKeys,
    get implementCalls() { return implementCalls; }
  };
}

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

test("an unknown outcome leaves a durable record carrying the request's idempotency key", async () => {
  const { agent } = await makeTask();
  const h = harness();

  const { result } = await runLoop(agent.id, h.orchestrator);
  assert.equal(result.stage, LOOP_STAGE.BLOCKED);

  const pending = await pendingReconciliations({ agentInstanceId: agent.id });
  assert.equal(pending.length, 1);
  const record = pending[0];

  assert.equal(record.nodeKind, MODEL_NODE_KINDS.MODEL_IMPLEMENT);
  assert.equal(record.provider, "fable");
  assert.equal(record.status, RECONCILIATION_STATUS.PENDING);
  // The key is what makes a lookup — or a safe provider-side replay — possible.
  assert.ok(record.idempotencyKey, "no idempotency key was recorded");
  assert.equal(record.idempotencyKey, h.seenKeys[0], "the record's key is not the one the provider was sent");
  // The possible charge was kept, not released.
  assert.ok(record.capturedMinor > 0, "an outcome that may have been billed was treated as free");
});

test("a provider that cannot answer is reported as unsupported, not guessed at", async () => {
  const { agent } = await makeTask();
  const h = harness();
  await runLoop(agent.id, h.orchestrator);

  const [record] = await pendingReconciliations({ agentInstanceId: agent.id });
  const outcome = await attemptProviderReconciliation({ recordId: record.id, registry: h.registry });

  assert.equal(outcome.supported, false);
  assert.equal(outcome.status, RECONCILIATION_STATUS.PENDING, "an unanswerable lookup resolved itself");
  assert.match(outcome.reason, /cannot look up/i);

  // Still pending: nothing was decided on the provider's behalf.
  const still = await pendingReconciliations({ agentInstanceId: agent.id });
  assert.equal(still.length, 1);
});

test("resolving as never-executed reopens the node and the task finishes without paying twice", async () => {
  const { agent } = await makeTask();
  const h = harness({ failImplementUntil: 1 });

  await runLoop(agent.id, h.orchestrator);
  assert.equal(h.implementCalls, 1, "the call was repeated before anyone established it was safe");

  const [record] = await pendingReconciliations({ agentInstanceId: agent.id });
  const resolved = await resolveReconciliation({
    recordId: record.id,
    completed: false,
    resolvedBy: "operator:test",
    note: "The provider's dashboard shows no such request."
  });

  assert.equal(resolved.status, RECONCILIATION_STATUS.RESOLVED_NOT_COMPLETED);
  assert.equal(resolved.reopened.accepted, true, "the node was not reopened");
  // Back in the queue: READY here because everything it depends on has already
  // succeeded, PENDING if it had not.
  assert.ok(
    ["ready", "pending"].includes(resolved.reopened.node.status),
    "reopened node is " + resolved.reopened.node.status
  );
  // The capture stands; what a finance reversal would be for is recorded.
  assert.ok(resolved.record.reversalOwedMinor > 0);

  await resumeAgent(agent.id, "Reconciled: the model call never happened");
  const { stages, result } = await runLoop(agent.id, h.orchestrator);

  assert.equal(result.stage, LOOP_STAGE.COMPLETED, "stages: " + stages.join(" -> "));
  assert.equal(h.implementCalls, 2, "the retry did not happen, or happened more than once");
  // The second attempt is a different attempt and carries a different key, so a
  // provider honouring idempotency does the work rather than replaying nothing.
  assert.notEqual(h.seenKeys[0], h.seenKeys[1]);

  const db = await loadDb();
  assert.equal(db.agentInstances.find(a => a.id === agent.id).status, AGENT_STATUS.COMPLETED);
});

test("resolving as executed keeps the charge and leaves the node failed", async () => {
  const { agent } = await makeTask();
  const h = harness();
  await runLoop(agent.id, h.orchestrator);

  const [record] = await pendingReconciliations({ agentInstanceId: agent.id });
  const resolved = await resolveReconciliation({
    recordId: record.id,
    completed: true,
    resolvedBy: "operator:test",
    note: "The provider billed for it."
  });

  assert.equal(resolved.status, RECONCILIATION_STATUS.RESOLVED_COMPLETED);
  assert.equal(resolved.reopened, null, "a call that was served was re-run anyway");
  assert.equal(resolved.record.reversalOwedMinor, 0);

  const db = await loadDb();
  const node = db.graphNodes.find(n => n.id === record.nodeId);
  assert.equal(node.status, "failed", "the node was revived despite the result being lost, not the money");

  // Resolving again changes nothing.
  const again = await resolveReconciliation({ recordId: record.id, completed: false });
  assert.equal(again.alreadyResolved, true);
  assert.equal(again.status, RECONCILIATION_STATUS.RESOLVED_COMPLETED);
});

test("an adapter that can look a request up settles the record itself", async () => {
  const { agent } = await makeTask();
  const h = harness({
    reconcile: async ({ idempotencyKey }) => ({ completed: false, checkedKey: idempotencyKey })
  });
  await runLoop(agent.id, h.orchestrator);

  const [record] = await pendingReconciliations({ agentInstanceId: agent.id });
  const outcome = await attemptProviderReconciliation({ recordId: record.id, registry: h.registry });

  assert.equal(outcome.supported, true);
  assert.equal(outcome.status, RECONCILIATION_STATUS.RESOLVED_NOT_COMPLETED);
  assert.equal(outcome.record.providerEvidence.checkedKey, record.idempotencyKey);
  assert.equal(outcome.reopened.accepted, true);
  assert.match(outcome.record.resolvedBy, /^provider:/);
});
