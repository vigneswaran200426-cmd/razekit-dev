import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Model phases end to end, through the real JEV path.
//
// Section 80 sets the bar for calling this real, and every clause of it is
// asserted below: an actual node exists, it executes, the provider call happens
// THROUGH that node's execution, the budget reservation precedes the spend, the
// result is persisted, the node completes, and a downstream node consumes the
// result.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-model-e2e-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-model-e2e-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";
// Price the model nodes through the real knob, so every node — including the
// ones appended by expansion — gets a reservation from the estimator rather
// than the test hand-patching the ones it happens to know about.
process.env.RAZEKIT_MODEL_NODE_COST = "1";

const { id, loadDb, transact } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant, tenantForTask } = await import("../src/tenant-security.js");
const { graphForTask } = await import("../src/jev.js");
const { executeNextNode } = await import("../src/jev-executor.js");
const { MODEL_NODE_KINDS } = await import("../src/jev-model-domain.js");
const { createModelGraphForAgent, expandWithExecutionPlan, expandWithRepair, nextModelGraphAction } =
  await import("../src/jev-model-graph.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask({ budget = 20 } = {}) {
  const tenantId = "tenant-e2e-" + (seq + 1);
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "user-e2e",
    taskType: "website",
    title: "Model E2E " + (++seq),
    originalRequest: "Build a landing page",
    specification: "Build a landing page",
    requestedTools: [],
    estimatedBudget: 5,
    maxBudget: budget,
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
  await transact(db => db.tasks.push(task));
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

const PLAN = {
  id: "fable-plan-1",
  version: 1,
  steps: [
    { id: "write-index", kind: "workspace_write_file", path: "index.html", content: "<main>built</main>" }
  ]
};

/**
 * A registry that records, in order, every provider call and — crucially — the
 * reservation state at the moment the call is made.
 *
 * That ordering is the property this whole phase exists to establish, and the
 * only way to prove it is to observe the ledger from inside the call.
 */
function orderedRegistry({ reviewDecisions = ["pass"], onCall = null } = {}) {
  const calls = [];
  let reviewIndex = 0;
  return {
    calls,
    get() {
      return {
        generate: async request => {
          const snapshot = onCall ? await onCall(request) : null;
          calls.push({ role: request.role, provider: request.provider, snapshot });

          if (request.role === "reviewer") {
            const decision = reviewDecisions[Math.min(reviewIndex, reviewDecisions.length - 1)];
            reviewIndex += 1;
            return {
              output: "review",
              review: { decision, reason: "decision " + decision, findings: [] },
              usage: { cost: 0.01 }
            };
          }
          if (request.role === "implementer") {
            return {
              output: "implemented",
              implementation: { status: "implemented", summary: "wrote the page", filesChanged: 1 },
              plan: PLAN,
              usage: { cost: 0.08 }
            };
          }
          return {
            output: "planned",
            architecture: { summary: "one page", steps: [] },
            usage: { cost: 0.03 }
          };
        }
      };
    }
  };
}

/** Drive the graph the way a worker pool would: claim, run, repeat. */
async function drainModelGraph({ agent, tenantId, registry, maxSteps = 40 }) {
  const executed = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const result = await executeNextNode({
      agentInstanceId: agent.id,
      workspaceRoot: workspaceDir,
      modelRegistry: registry
    });

    if (!result) {
      // Nothing claimable: the graph may need expanding before it can continue.
      const action = await nextModelGraphAction({ taskId: agent.taskId, tenantId });
      if (action.action === "expand-execution") {
        const plan = action.implementNode.output?.structured?.plan;
        await expandWithExecutionPlan({ graphId: action.graphId, agent, cycle: action.cycle, plan });
        continue;
      }
      if (action.action === "expand-repair") {
        await expandWithRepair({ graphId: action.graphId, reviewKey: action.reviewKey, cycle: action.cycle });
        continue;
      }
      return { executed, action };
    }
    executed.push({ key: result.node.key, kind: result.node.kind, status: result.status });
  }
  throw new Error("graph did not settle: " + executed.map(e => e.key).join(" -> "));
}

test("model phases execute as real JEV nodes, reserving before every provider call", async () => {
  const { task, agent, tenantId } = await makeTask({ budget: 20 });
  const { graph } = await createModelGraphForAgent(agent.id);

  // At the instant of each provider call, capture the live reservation state.
  const registry = orderedRegistry({
    onCall: async () => {
      const db = await loadDb();
      const held = db.billingReservations.filter(
        r => r.agentInstanceId === agent.id && r.status === "reserved"
      );
      return { heldCount: held.length, heldAmount: held.reduce((s, r) => s + Number(r.amount || 0), 0) };
    }
  });

  const { executed, action } = await drainModelGraph({ agent, tenantId, registry });

  // ── 1. Every model phase is an actual node, and it executed ───────────────
  const keys = executed.map(e => e.key);
  assert.ok(keys.includes("astra-plan"), "Astra planned as a node");
  assert.ok(keys.includes("fable-implement"), "Fable implemented as a node");
  assert.ok(keys.includes("exec1:write-index"), "the planned work ran as a node");
  assert.ok(keys.includes("astra-review-1"), "Astra reviewed as a node");
  assert.ok(executed.every(e => e.status === "succeeded"), JSON.stringify(executed));

  // ── 2. The provider call happened THROUGH node execution ──────────────────
  assert.deepEqual(
    registry.calls.map(c => c.role),
    ["planner", "implementer", "reviewer"],
    "one provider call per model node, in dependency order"
  );

  // ── 3. Reservation preceded every spend ───────────────────────────────────
  for (const call of registry.calls) {
    assert.equal(
      call.snapshot.heldCount, 1,
      "a reservation was already held when the provider was called (" + call.role + ")"
    );
    assert.ok(call.snapshot.heldAmount > 0, "and it held real budget");
  }

  const db = await loadDb();

  // ── 4. Results are persisted, and downstream nodes consumed them ──────────
  const nodes = db.graphNodes.filter(n => n.graphId === graph.id);
  const byKey = new Map(nodes.map(n => [n.key, n]));

  assert.equal(byKey.get("astra-plan").output.agent, "astra");
  assert.equal(byKey.get("fable-implement").output.agent, "fable");
  assert.ok(byKey.get("fable-implement").output.structured.plan, "the implementation stored its plan");
  assert.equal(byKey.get("astra-review-1").output.structured.review.decision, "pass");

  // The execution node exists BECAUSE the implementation produced that plan —
  // the downstream dependency genuinely consumed the upstream result.
  assert.ok(byKey.get("exec1:write-index"), "the plan became execution nodes");
  assert.deepEqual(byKey.get("exec1:write-index").dependsOn, ["fable-implement"]);

  // And it did real work on disk, not a simulation.
  const html = await readFile(path.join(workspaceDir, "index.html"), "utf8");
  assert.match(html, /built/);

  // ── 5. Every node completed, and none still holds budget ──────────────────
  assert.ok(nodes.every(n => n.status === "succeeded"), "all nodes succeeded");
  assert.equal(
    db.billingReservations.filter(r => r.agentInstanceId === agent.id && r.status === "reserved").length,
    0,
    "no reservation is left holding budget nobody can spend"
  );

  // ── 6. Actual cost captured, unused released, through billing.js ──────────
  const reservations = db.billingReservations.filter(r => r.agentInstanceId === agent.id);
  assert.equal(reservations.length, 3, "one reservation per model node");
  for (const r of reservations) {
    assert.equal(r.status, "captured");
    assert.ok(r.reservedAmount > 0, "a real ceiling was held");
    assert.ok(r.capturedAmount < r.reservedAmount, "less was captured than held");
    assert.equal(
      Math.round((r.capturedAmount + r.releasedAmount) * 100),
      Math.round(r.reservedAmount * 100),
      "captured + released accounts for the whole reservation"
    );
  }
  // Provider-reported costs: 0.03 plan + 0.08 implement + 0.01 review.
  const charged = reservations.reduce((sum, r) => sum + r.capturedAmount, 0);
  assert.equal(Math.round(charged * 100), 12);
  assert.equal(Math.round(db.agentInstances.find(a => a.id === agent.id).budgetUsed * 100), 12);

  // No second ledger — these are billing.js's own entries.
  assert.equal(db.billingLedger.filter(e => e.agentInstanceId === agent.id).length, 3);

  assert.equal(action.action, "expand-verify", "a passing review asks for the verification node to be created");
  assert.equal(task.id, agent.taskId);
});

test("a revise verdict appends a repair cycle, and history is preserved", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  const { graph } = await createModelGraphForAgent(agent.id);
  // First review revises; the second passes.
  const registry = orderedRegistry({ reviewDecisions: ["revise", "pass"] });
  const { executed, action } = await drainModelGraph({ agent, tenantId, registry });

  const keys = executed.map(e => e.key);
  assert.ok(keys.includes("astra-review-1"));
  assert.ok(keys.includes("fable-repair-1"), "a repair node was created and ran");
  assert.ok(keys.includes("exec2:write-index"), "the repair produced a second execution cycle");
  assert.ok(keys.includes("astra-review-2"), "and the repair was reviewed");
  assert.equal(action.action, "expand-verify");

  const db = await loadDb();
  const nodes = db.graphNodes.filter(n => n.graphId === graph.id);
  const byKey = new Map(nodes.map(n => [n.key, n]));

  // History preserved: the first implementation and first review still carry
  // their own results. Node #5 was not rewritten to pretend it was the final one.
  assert.equal(byKey.get("astra-review-1").output.structured.review.decision, "revise");
  assert.equal(byKey.get("astra-review-2").output.structured.review.decision, "pass");
  assert.ok(byKey.get("fable-implement").output, "the original implementation's result survives");
  assert.deepEqual(byKey.get("fable-repair-1").dependsOn, ["astra-review-1"]);

  // The repair was billed as its own node, with its own reservation.
  const reservations = db.billingReservations.filter(r => r.agentInstanceId === agent.id);
  assert.equal(reservations.length, 5, "plan, implement, review, repair, review");
  assert.ok(reservations.every(r => r.status === "captured"));
});

test("no repair budget is reserved when the review passes first time", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  const { graph } = await createModelGraphForAgent(agent.id);
  const registry = orderedRegistry({ reviewDecisions: ["pass"] });
  await drainModelGraph({ agent, tenantId, registry });

  const db = await loadDb();
  const nodes = db.graphNodes.filter(n => n.graphId === graph.id);
  assert.ok(
    !nodes.some(n => n.kind === MODEL_NODE_KINDS.MODEL_REPAIR),
    "a repair node that was never needed was never created"
  );
  // Three model nodes ran, so exactly three model reservations exist — a
  // conditional branch reserved nothing.
  assert.equal(db.billingReservations.filter(r => r.agentInstanceId === agent.id).length, 3);
});

test("the graph stops when the budget runs out, without calling the provider again", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  const { graph } = await createModelGraphForAgent(agent.id);
  const registry = orderedRegistry();

  // Run the plan node, then exhaust the budget before the implementation.
  const first = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });
  assert.equal(first.status, "succeeded");
  const callsAfterPlan = registry.calls.length;

  await transact(db => {
    db.agentInstances.find(a => a.id === agent.id).budgetUsed = 19.99;
  });

  const second = await executeNextNode({
    agentInstanceId: agent.id, workspaceRoot: workspaceDir, modelRegistry: registry
  });

  assert.equal(second.status, "budget_refused");
  assert.equal(
    registry.calls.length, callsAfterPlan,
    "the provider was not called for a node that could not be afforded"
  );

  const db = await loadDb();
  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });

  // The implementation is terminal rather than left pending forever, and the
  // graph says so instead of sitting at "running" with no worker.
  assert.equal(view.nodes.find(n => n.key === "fable-implement").status, "failed");
  assert.equal(view.graph.status, "failed");

  // Nothing was expanded off a node that never produced a plan.
  assert.ok(!view.nodes.some(n => n.key.startsWith("exec")), "no execution work was invented");
  assert.equal(
    db.billingReservations.filter(r => r.agentInstanceId === agent.id && r.status === "reserved").length,
    0
  );
});
