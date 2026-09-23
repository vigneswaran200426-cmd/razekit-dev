import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-model-node-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-model-node-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { id, loadDb, transact } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { NODE_STATUS } = await import("../src/jev-domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { createTaskGraph, graphForTask, expandGraph, claimNextNode, sweepStalledNodes, completeNode } =
  await import("../src/jev.js");
const { executeNextNode } = await import("../src/jev-executor.js");
const { ModelRuntimeError } = await import("../src/model-runtime.js");
const {
  MODEL_NODE_KINDS, REVIEW_OUTCOMES, normalizeReviewResult,
  estimateModelNodeCostMinor, roleForModelKind, agentForModelKind, usageCostMinor
} = await import("../src/jev-model-domain.js");
const { createModelGraphForAgent, expandWithExecutionPlan, expandWithRepair, nextModelGraphAction } =
  await import("../src/jev-model-graph.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask({ tenantId = null, budget = 20, agentType = AGENT_TYPES.NIOMI } = {}) {
  tenantId = tenantId || "tenant-model-" + (seq + 1);
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "user-model",
    taskType: agentType === AGENT_TYPES.KONAMI ? "game" : "website",
    title: "Model node test " + (++seq),
    originalRequest: "Build something",
    specification: "Build something",
    requestedTools: [],
    estimatedBudget: 5,
    maxBudget: budget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType,
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
  await transact(db => db.tasks.push(task));
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

/**
 * A registry that records every provider call.
 *
 * `calls` is the load-bearing assertion surface: several tests below exist
 * purely to prove it stayed empty.
 */
function recordingRegistry({ response = null, fail = null, usage = { cost: 0.05 } } = {}) {
  const calls = [];
  return {
    calls,
    get() {
      return {
        generate: async request => {
          calls.push({ provider: request.provider, role: request.role, prompt: request.prompt });
          if (fail) throw fail();
          return response ?? {
            output: "done",
            plan: { id: "model-plan-1", version: 1, steps: [
              { id: "write", kind: "workspace_write_file", path: "index.html", content: "<main></main>" }
            ] },
            review: { decision: "pass", reason: "Execution completed.", findings: [] },
            implementation: { status: "implemented", summary: "wrote a file", filesChanged: 1 },
            usage
          };
        }
      };
    }
  };
}

const modelNode = (key, kind, deps = [], budgetMinor = 0) => ({
  key, kind, dependsOn: deps, budgetMinor,
  payload: { agent: agentForModelKind(kind), kind }
});

// ── Domain ───────────────────────────────────────────────────────────────────

test("model node kinds map to the right agent and session role", () => {
  assert.equal(agentForModelKind(MODEL_NODE_KINDS.MODEL_PLAN), "astra");
  assert.equal(agentForModelKind(MODEL_NODE_KINDS.MODEL_IMPLEMENT), "fable");
  // Repair is Fable doing the same job with findings attached, not a third role.
  assert.equal(roleForModelKind(MODEL_NODE_KINDS.MODEL_REPAIR), roleForModelKind(MODEL_NODE_KINDS.MODEL_IMPLEMENT));
  assert.equal(roleForModelKind(MODEL_NODE_KINDS.MODEL_REVIEW), "reviewer");
});

test("a malformed review is treated as revise, never as pass", () => {
  assert.equal(normalizeReviewResult({ decision: "pass" }).decision, REVIEW_OUTCOMES.PASS);
  // An unreadable review is not evidence the work is correct.
  assert.equal(normalizeReviewResult({ decision: "looks good to me" }).decision, REVIEW_OUTCOMES.REVISE);
  assert.equal(normalizeReviewResult(null).decision, REVIEW_OUTCOMES.REVISE);
  assert.equal(normalizeReviewResult(undefined).malformed, true);
});

test("cost estimation returns a range, and zero base reserves nothing", () => {
  const zero = estimateModelNodeCostMinor(MODEL_NODE_KINDS.MODEL_IMPLEMENT, { baseMinor: 0 });
  assert.equal(zero.maximumMinor, 0);

  const priced = estimateModelNodeCostMinor(MODEL_NODE_KINDS.MODEL_IMPLEMENT, { baseMinor: 100 });
  assert.ok(priced.minimumMinor < priced.expectedMinor);
  assert.ok(priced.expectedMinor < priced.maximumMinor, "the ceiling leaves room for a retry");
  assert.ok(priced.confidence < 0.5, "an estimate is not presented as certain");

  // Implementation is priced above review, which reads rather than writes.
  const review = estimateModelNodeCostMinor(MODEL_NODE_KINDS.MODEL_REVIEW, { baseMinor: 100 });
  assert.ok(priced.expectedMinor > review.expectedMinor);
});

test("provider usage converts to minor units, and 'unmeasured' is not zero", () => {
  assert.equal(usageCostMinor({ cost: 0.26 }), 26);
  assert.equal(usageCostMinor({ costMinor: 42 }), 42);
  assert.equal(usageCostMinor({}), null, "no measurement is a distinct answer from zero");
  assert.equal(usageCostMinor({ cost: 0 }), 0);
});

// ── Graph expansion ──────────────────────────────────────────────────────────

test("a running graph can be expanded, and the new node waits on the existing one", async () => {
  const { agent, tenantId } = await makeTask();
  const { graph } = await createTaskGraph({
    tenantId, taskId: agent.taskId, nodes: [{ key: "a", dependsOn: [] }]
  });

  const result = await expandGraph({ graphId: graph.id, nodes: [{ key: "b", dependsOn: ["a"] }] });
  assert.deepEqual(result.added.map(n => n.key), ["b"]);

  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  assert.equal(view.nodes.length, 2);
  assert.equal(view.nodes.find(n => n.key === "b").status, NODE_STATUS.PENDING);
});

test("an expansion that would close a cycle is rejected", async () => {
  const { agent, tenantId } = await makeTask();
  const { graph } = await createTaskGraph({
    tenantId, taskId: agent.taskId, nodes: [{ key: "a", dependsOn: [] }, { key: "b", dependsOn: ["a"] }]
  });

  // c depends on b; making a depend on c would be a cycle — but a is existing
  // and cannot be rewritten, so the equivalent test is a self-referential add.
  await assert.rejects(
    () => expandGraph({ graphId: graph.id, nodes: [{ key: "c", dependsOn: ["d"] }, { key: "d", dependsOn: ["c"] }] }),
    /dependency cycle/
  );
  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  assert.equal(view.nodes.length, 2, "nothing was stored");
});

test("an expansion cannot reuse an existing key or touch a settled graph", async () => {
  const { agent, tenantId } = await makeTask();
  const { graph } = await createTaskGraph({
    tenantId, taskId: agent.taskId, nodes: [{ key: "a", dependsOn: [] }]
  });

  await assert.rejects(
    () => expandGraph({ graphId: graph.id, nodes: [{ key: "a", dependsOn: [] }] }),
    /already contains a node with key/
  );

  const { cancelGraph } = await import("../src/jev.js");
  await cancelGraph({ graphId: graph.id, reason: "test" });
  await assert.rejects(
    () => expandGraph({ graphId: graph.id, nodes: [{ key: "z", dependsOn: [] }] }),
    /Cannot expand a graph that is/
  );
});

// ── Reserve before the provider call ─────────────────────────────────────────

test("a model node that cannot be afforded NEVER reaches the provider", async () => {
  const { agent } = await makeTask({ budget: 10 });
  await createTaskGraph({
    tenantId: await (await import("../src/tenant-security.js")).tenantForTask(agent.taskId),
    taskId: agent.taskId,
    nodes: [modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN, [], 1000)]
  });

  // Spend almost everything behind the graph's back.
  await transact(db => {
    db.agentInstances.find(a => a.id === agent.id).budgetUsed = 9.95;
  });

  const registry = recordingRegistry();
  const result = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });

  assert.equal(result.status, "budget_refused");
  assert.deepEqual(
    registry.calls, [],
    "THE POINT OF THIS PHASE: the provider was never called, so no money was spent"
  );
  assert.equal(result.node.status, NODE_STATUS.FAILED);
});

test("a model node reserves, calls the provider, then captures what was used", async () => {
  const { agent } = await makeTask({ budget: 10 });
  const { tenantForTask } = await import("../src/tenant-security.js");
  await createTaskGraph({
    tenantId: await tenantForTask(agent.taskId),
    taskId: agent.taskId,
    nodes: [modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN, [], 500)]
  });

  // Reserved 500 minor (5 USD); the provider reports 0.05 USD = 5 minor.
  const registry = recordingRegistry({ usage: { cost: 0.05, inputTokens: 100, outputTokens: 50 } });
  const result = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });

  assert.equal(result.status, "succeeded");
  assert.equal(registry.calls.length, 1);

  const db = await loadDb();
  const reservation = db.billingReservations.find(r => r.agentInstanceId === agent.id);
  assert.ok(reservation, "the reservation went through the existing billing system");
  assert.equal(reservation.status, "captured");
  assert.equal(reservation.reservedAmount, 5, "5 USD held");
  assert.equal(reservation.capturedAmount, 0.05, "only what the provider reported was charged");
  assert.equal(reservation.releasedAmount, 4.95, "the rest was released, not charged");

  // No second ledger: this is billing.js's own record.
  assert.ok(db.billingLedger.some(entry => entry.reservationId === reservation.id));
});

test("a rejected provider call releases the whole hold", async () => {
  const { agent } = await makeTask({ budget: 10 });
  const { tenantForTask } = await import("../src/tenant-security.js");
  await createTaskGraph({
    tenantId: await tenantForTask(agent.taskId),
    taskId: agent.taskId,
    nodes: [modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN, [], 500)]
  });

  const registry = recordingRegistry({
    fail: () => new ModelRuntimeError("invalid request", { retryable: false, transmitted: false })
  });
  const result = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });

  assert.equal(result.status, "failed");
  const db = await loadDb();
  const reservation = db.billingReservations.find(r => r.agentInstanceId === agent.id);
  assert.equal(reservation.status, "released", "the provider rejected it; there is nothing to pay for");
  assert.equal(db.agentInstances.find(a => a.id === agent.id).budgetUsed, 0);
});

// ── Unknown provider outcome ─────────────────────────────────────────────────

test("a timeout after transmission is UNKNOWN: never retried, and charged", async () => {
  const { agent } = await makeTask({ budget: 10 });
  const { tenantForTask } = await import("../src/tenant-security.js");
  await createTaskGraph({
    tenantId: await tenantForTask(agent.taskId),
    taskId: agent.taskId,
    // Four attempts allowed — none of which may be used.
    nodes: [{ ...modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN, [], 500), maxAttempts: 4 }]
  });

  const registry = recordingRegistry({
    fail: () => {
      const error = new ModelRuntimeError("socket hang up", { retryable: true });
      error.transmitted = true;
      return error;
    }
  });

  const result = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });

  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.node.status, NODE_STATUS.FAILED, "terminal despite three attempts remaining");
  assert.equal(registry.calls.length, 1, "the call was NOT repeated — it may already have been billed");

  // The reservation is captured, not released: the provider may have served it.
  const db = await loadDb();
  const reservation = db.billingReservations.find(r => r.agentInstanceId === agent.id);
  assert.equal(reservation.status, "captured");
  assert.equal(reservation.capturedAmount, 5, "a possible charge is not treated as free");
});

test("a transient failure that never left the client IS retried", async () => {
  const { agent } = await makeTask({ budget: 10 });
  const { tenantForTask } = await import("../src/tenant-security.js");
  await createTaskGraph({
    tenantId: await tenantForTask(agent.taskId),
    taskId: agent.taskId,
    nodes: [{ ...modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN, [], 200), maxAttempts: 3 }]
  });

  const registry = recordingRegistry({
    fail: () => new ModelRuntimeError("connection refused", { retryable: true, transmitted: false })
  });
  const result = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });

  assert.equal(result.status, "retry_scheduled");
  assert.equal(result.node.status, NODE_STATUS.READY, "a request that never left is safe to send again");
});

// ── Lease and recovery ───────────────────────────────────────────────────────

test("a model node whose worker died is recovered like any other node", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  await createTaskGraph({
    tenantId, taskId: agent.taskId,
    nodes: [{ ...modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN, [], 0), maxAttempts: 3 }]
  });

  const claim = await claimNextNode({ taskId: agent.taskId, tenantId, workerId: "w-dead", leaseMs: 1000 });
  assert.ok(claim);

  const later = new Date(Date.now() + 5000);
  const swept = await sweepStalledNodes({ now: later, tenantId });
  assert.deepEqual(swept.recovered.map(r => r.key), ["astra-plan"]);

  const registry = recordingRegistry();
  const result = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry, now: later
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.node.attempt, 2);
});

test("a model node with no registry fails closed rather than being skipped", async () => {
  const { agent, tenantId } = await makeTask();
  await createTaskGraph({
    tenantId, taskId: agent.taskId,
    nodes: [modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN)]
  });

  const result = await executeNextNode({ agentInstanceId: agent.id, workspaceRoot: workspaceDir });
  assert.equal(result.status, "failed");
  assert.match(result.error, /No model registry/);
});

// ── Model graph shape ────────────────────────────────────────────────────────

test("the task graph starts as plan -> implement, with the review appended later", async () => {
  const { agent, tenantId } = await makeTask();
  const { nodes } = await createModelGraphForAgent(agent.id);

  // The review is deliberately absent here: it is appended alongside the
  // execution it reviews, so it can never judge work that has not run.
  assert.deepEqual(nodes.map(n => n.key), ["astra-plan", "fable-implement"]);
  assert.equal(nodes[0].kind, MODEL_NODE_KINDS.MODEL_PLAN);
  assert.equal(nodes[1].kind, MODEL_NODE_KINDS.MODEL_IMPLEMENT);
  assert.deepEqual(nodes[1].dependsOn, ["astra-plan"]);

  // Only the plan is claimable — the implementation waits on it.
  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  assert.equal(view.nodes.find(n => n.key === "astra-plan").status, NODE_STATUS.READY);
  assert.equal(view.nodes.find(n => n.key === "fable-implement").status, NODE_STATUS.PENDING);
});

test("the implementation's plan becomes execution nodes appended to the live graph", async () => {
  const { agent, tenantId } = await makeTask();
  const { graph } = await createModelGraphForAgent(agent.id);

  const result = await expandWithExecutionPlan({
    graphId: graph.id,
    agent,
    cycle: 1,
    plan: { id: "p1", version: 1, steps: [
      { id: "write", kind: "workspace_write_file", path: "a.html", content: "x" },
      { id: "test", kind: "command", executable: "npm", args: ["test"] }
    ] }
  });

  assert.deepEqual(result.executionKeys, ["exec1:write", "exec1:test"]);
  assert.equal(result.reviewKey, "astra-review-1");

  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  const byKey = new Map(view.nodes.map(n => [n.key, n]));
  // The first execution node hangs off the implementation, not off nothing.
  assert.deepEqual(byKey.get("exec1:write").dependsOn, ["fable-implement"]);
  // The review now waits on the execution, so it reviews a result rather than
  // an intention.
  assert.ok(byKey.get("astra-review-1").dependsOn.includes("exec1:test"));
});

test("a repair branch is appended only when the review asks for one", async () => {
  const { agent, tenantId } = await makeTask();
  const { graph } = await createModelGraphForAgent(agent.id);
  await expandWithExecutionPlan({
    graphId: graph.id, agent, cycle: 1,
    plan: { id: "p1", version: 1, steps: [{ id: "write", kind: "workspace_write_file", path: "a.html", content: "x" }] }
  });

  let view = await graphForTask({ taskId: agent.taskId, tenantId });
  assert.ok(!view.nodes.some(n => n.key.startsWith("fable-repair")), "no repair node exists yet");

  await expandWithRepair({ graphId: graph.id, reviewKey: "astra-review-1", cycle: 1 });

  view = await graphForTask({ taskId: agent.taskId, tenantId });
  const repair = view.nodes.find(n => n.key === "fable-repair-1");
  assert.ok(repair, "the repair node was appended");
  assert.equal(repair.kind, MODEL_NODE_KINDS.MODEL_REPAIR);
  assert.deepEqual(repair.dependsOn, ["astra-review-1"]);

  // History is preserved — the first implementation node is untouched.
  assert.ok(view.nodes.some(n => n.key === "fable-implement"));
});

test("the next action is derived from stored node output, not remembered", async () => {
  const { agent, tenantId } = await makeTask();
  const { graph } = await createModelGraphForAgent(agent.id);
  await expandWithExecutionPlan({
    graphId: graph.id, agent, cycle: 1,
    plan: { id: "p1", version: 1, steps: [{ id: "write", kind: "workspace_write_file", path: "a.html", content: "x" }] }
  });

  // Mark the review succeeded with a REVISE verdict, exactly as the model
  // executor would have stored it.
  await transact(db => {
    const review = db.graphNodes.find(n => n.graphId === graph.id && n.key === "astra-review-1");
    review.status = "succeeded";
    review.output = { structured: { review: { decision: "revise", reason: "tests failed", findings: [] } } };
  });

  const action = await nextModelGraphAction({ taskId: agent.taskId, tenantId });
  assert.equal(action.action, "expand-repair");
  assert.equal(action.reviewKey, "astra-review-1");
  assert.equal(action.cycle, 1);
});

test("a passing review asks for verification instead of repair", async () => {
  const { agent, tenantId } = await makeTask();
  const { graph } = await createModelGraphForAgent(agent.id);
  await expandWithExecutionPlan({
    graphId: graph.id, agent, cycle: 1,
    plan: { id: "p1", version: 1, steps: [{ id: "write", kind: "workspace_write_file", path: "a.html", content: "x" }] }
  });
  await transact(db => {
    const review = db.graphNodes.find(n => n.graphId === graph.id && n.key === "astra-review-1");
    review.status = "succeeded";
    review.output = { structured: { review: { decision: "pass", reason: "ok", findings: [] } } };
  });

  const action = await nextModelGraphAction({ taskId: agent.taskId, tenantId });
  assert.equal(action.action, "verify");
});

// ── Profiles ─────────────────────────────────────────────────────────────────

test("a Konami model graph uses Konami's plan contract for its execution nodes", async () => {
  const { agent } = await makeTask({ agentType: AGENT_TYPES.KONAMI });
  const { graph } = await createModelGraphForAgent(agent.id);

  // An App/Web plan must not be accepted for a game agent.
  await assert.rejects(
    () => expandWithExecutionPlan({
      graphId: graph.id, agent, cycle: 1,
      plan: { id: "p", version: 1, steps: [{ id: "w", kind: "workspace_write_file", path: "a.js", content: "x" }] }
    }),
    /engine is invalid|usable execution plan/
  );

  const ok = await expandWithExecutionPlan({
    graphId: graph.id, agent, cycle: 1,
    plan: { id: "gp", version: 1, engine: "godot", steps: [{ id: "pt", kind: "playtest", checks: ["boots"] }] }
  });
  assert.deepEqual(ok.executionKeys, ["exec1:pt"]);
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test("another tenant cannot read or claim a model graph", async () => {
  const { agent, tenantId } = await makeTask();
  await createModelGraphForAgent(agent.id);

  assert.equal(await graphForTask({ taskId: agent.taskId, tenantId: "tenant-somebody-else" }), null);
  assert.equal(
    await claimNextNode({ taskId: agent.taskId, tenantId: "tenant-somebody-else", workerId: "w" }),
    null
  );
  assert.ok(await claimNextNode({ taskId: agent.taskId, tenantId, workerId: "w" }));
});

// ── Audit ────────────────────────────────────────────────────────────────────

test("a model node records provider, model and cost without the prompt or response body", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  await createTaskGraph({
    tenantId, taskId: agent.taskId,
    nodes: [modelNode("astra-plan", MODEL_NODE_KINDS.MODEL_PLAN, [], 300)]
  });

  const registry = recordingRegistry({ usage: { cost: 0.02, inputTokens: 10, outputTokens: 5 } });
  const result = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });

  const output = result.node.output;
  assert.equal(output.agent, "astra");
  assert.ok(output.provider);
  assert.ok(output.model);
  assert.equal(output.attempt, 1);
  assert.equal(output.status, "succeeded");
  assert.equal(output.costMinor, 2);
  assert.equal(output.reservedMinor, 300);

  // The node result carries structure, not transcripts.
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes("You are part of an isolated autonomous development agent"),
    "the system prompt is not stored on the node");

  // And the graph expansion / phase events are observable.
  const db = await loadDb();
  assert.ok(db.observabilityEvents.some(e => e.kind === "model_phase" && e.status === "succeeded"));
});
