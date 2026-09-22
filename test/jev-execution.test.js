import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-jev-exec-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-jev-exec-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { id, loadDb, transact } = await import("../src/store.js");
const { TASK_STATUS } = await import("../src/domain.js");
const { NODE_STATUS, GRAPH_STATUS } = await import("../src/jev-domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { APP_WEB_STEP_KINDS } = await import("../src/app-web-domain.js");
const { createGraphForAgent, executeNextNode, drainGraph } = await import("../src/jev-executor.js");
const { claimNextNode, graphForTask, cancelGraph, completeNode } = await import("../src/jev.js");
const { ToolBroker, ToolAdapterRegistry } = await import("../src/tool-broker.js");
const { reserveSpend, captureSpend, releaseSpend } = await import("../src/billing.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;

// Each task gets its own tenant unless one is named.
//
// The tenant hourly spend ceiling in billing.js is real and it is per tenant,
// so tests that actually move money accumulate against each other when they
// share one. That is correct product behaviour and a broken test fixture: a
// later test fails for a reason that has nothing to do with what it asserts.
async function makeTask({ tenantId = null, userId = "user-jev", budget = 20, toolScopes = null } = {}) {
  tenantId = tenantId || "tenant-jev-" + (seq + 1);
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId,
    taskType: "website",
    title: "JEV execution test " + (++seq),
    originalRequest: "Build a website",
    specification: "Build a website",
    requestedTools: [],
    estimatedBudget: 5,
    maxBudget: budget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "niomi",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      // The permission broker grants only what the task preauthorized. Left
      // unset, every tool call is refused for want of permission — which is the
      // correct default, and means a test about NODE scope has to grant the
      // agent-level scope first or it proves nothing about narrowing.
      toolScopes: toolScopes || [],
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

const write = (id, path) => ({ id, kind: APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE, path, content: "x" });
const command = (id, args = ["test"]) => ({ id, kind: APP_WEB_STEP_KINDS.COMMAND, executable: "npm", args });
const plan = (planId, steps) => ({ id: planId, version: 1, steps });

/** A runtime that records what it was asked to do and never touches a disk. */
function recordingRuntime({ failOn = [], failTimes = {}, usage = null } = {}) {
  const calls = [];
  const attempts = new Map();
  return {
    calls,
    async execute(step) {
      calls.push(step.id);
      const count = (attempts.get(step.id) || 0) + 1;
      attempts.set(step.id, count);

      if (failOn.includes(step.id)) {
        const limit = failTimes[step.id];
        if (limit === undefined || count <= limit) {
          const error = new Error("deliberate failure in " + step.id);
          error.retryable = failTimes[step.id] !== undefined;
          throw error;
        }
      }
      return usage ? { operation: step.kind, usage } : { operation: step.kind };
    }
  };
}

// ── Graph creation from a plan ───────────────────────────────────────────────

test("an agent's plan becomes a stored graph with the budget spread over it", async () => {
  const { task, agent, tenantId } = await makeTask({ budget: 10 });
  const { graph, nodes } = await createGraphForAgent(agent.id, {
    plan: plan("plan-a", [write("w", "a.js"), command("test"), command("build", ["run", "build"])]),
    totalBudgetMinor: 1000
  });

  assert.equal(graph.taskId, task.id);
  assert.equal(graph.planId, "plan-a");
  assert.equal(graph.tenantId, tenantId);
  assert.equal(nodes.length, 3);

  // The whole remaining budget, in minor units, on the steps that spend.
  const total = nodes.reduce((sum, node) => sum + node.budgetMinor, 0);
  assert.equal(total, 1000, "10 USD remaining becomes 1000 minor units");
  assert.equal(nodes.find(n => n.key === "w").budgetMinor, 0);
});

test("the graph reserves only the budget that is left, not the whole limit", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  await transact(db => {
    db.agentInstances.find(item => item.id === agent.id).budgetUsed = 6;
  });

  const { nodes } = await createGraphForAgent(agent.id, {
    plan: plan("plan-b", [command("test")]),
    totalBudgetMinor: 1000
  });
  assert.equal(nodes[0].budgetMinor, 400, "4 USD remaining, not 10");
});

// ── Reservation before execution ─────────────────────────────────────────────

test("a node holds its budget before it runs and settles it after", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  await createGraphForAgent(agent.id, { plan: plan("plan-c", [command("test")]), totalBudgetMinor: 1000 });

  const runtime = recordingRuntime();
  const result = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "succeeded");
  const db = await loadDb();
  const reservation = db.billingReservations.find(item => item.agentInstanceId === agent.id);
  assert.ok(reservation, "a reservation was taken");
  assert.equal(reservation.status, "captured");
  // No reservation is left holding budget nobody can spend.
  assert.equal(
    db.billingReservations.filter(r => r.agentInstanceId === agent.id && r.status === "reserved").length,
    0
  );
});

test("a node that reports lower usage captures less and releases the rest", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  await createGraphForAgent(agent.id, { plan: plan("plan-d", [command("test")]), totalBudgetMinor: 1000 });

  // 1000 minor reserved; the runtime says it really cost 250.
  const runtime = recordingRuntime({ usage: { costMinor: 250 } });
  await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  const db = await loadDb();
  const reservation = db.billingReservations.find(item => item.agentInstanceId === agent.id);
  assert.equal(reservation.status, "captured");
  assert.equal(reservation.reservedAmount, 10);
  assert.equal(reservation.capturedAmount, 2.5);
  assert.equal(reservation.releasedAmount, 7.5);

  const agentRow = db.agentInstances.find(item => item.id === agent.id);
  assert.equal(agentRow.budgetUsed, 2.5, "only what was spent is charged");
});

test("a node that cannot be afforded never runs", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  await createGraphForAgent(agent.id, {
    plan: plan("plan-e", [command("first"), command("second")]),
    totalBudgetMinor: 1000
  });

  // Spend almost all of it behind the graph's back, so the first node's
  // reservation cannot be met.
  await transact(db => {
    db.agentInstances.find(item => item.id === agent.id).budgetUsed = 9.9;
  });

  const runtime = recordingRuntime();
  const result = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "budget_refused");
  assert.equal(result.limit, "agent-budget");
  assert.deepEqual(runtime.calls, [], "the runtime was never invoked");
  assert.equal(result.node.status, NODE_STATUS.FAILED);
  // The rest of the graph is buried rather than left pending forever.
  assert.ok(result.skipped.some(entry => entry.key === "second"));
});

test("a budget refusal is not retried", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  await createGraphForAgent(agent.id, {
    plan: plan("plan-f", [{ ...command("only"), retries: 5 }]),
    totalBudgetMinor: 1000
  });
  await transact(db => {
    db.agentInstances.find(item => item.id === agent.id).budgetUsed = 9.99;
  });

  const runtime = recordingRuntime();
  const result = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "budget_refused");
  assert.equal(result.node.status, NODE_STATUS.FAILED, "terminal despite five retries being allowed");
});

test("concurrent reservations see each other, so two nodes cannot overspend together", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });

  // Two independent nodes, each reserving 6 of a 10 budget. Together they
  // exceed it, so exactly one may proceed.
  const first = await reserveSpend(agent.id, 6, "node-1", { idempotencyKey: "k1" });
  assert.ok(first);
  await assert.rejects(
    () => reserveSpend(agent.id, 6, "node-2", { idempotencyKey: "k2" }),
    /Hard budget limit exceeded/
  );

  await releaseSpend(first.id);
  // With the first released, the second now fits.
  const second = await reserveSpend(agent.id, 6, "node-2", { idempotencyKey: "k2" });
  assert.ok(second);
});

test("capturing more than was reserved is refused", async () => {
  const { agent, tenantId } = await makeTask({ budget: 10 });
  const reservation = await reserveSpend(agent.id, 2, "small", { idempotencyKey: "over" });
  await assert.rejects(
    () => captureSpend(reservation.id, { actualAmount: 5 }),
    /exceeds the reserved amount/
  );
});

// ── Concurrency, retry, propagation, cancellation ────────────────────────────

test("two workers draining one graph never execute the same node", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  await createGraphForAgent(agent.id, {
    plan: plan("plan-g", [write("a", "a.js"), write("b", "b.js"), write("c", "c.js")])
  });

  const runtime = recordingRuntime();
  const claims = await Promise.all([
    executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir, workerId: "w1" }),
    executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir, workerId: "w2" }),
    executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir, workerId: "w3" })
  ]);

  const keys = claims.filter(Boolean).map(c => c.node.key).sort();
  assert.deepEqual(keys, ["a", "b", "c"]);
  assert.equal(new Set(runtime.calls).size, runtime.calls.length, "no step ran twice");
});

test("a retryable failure runs again; the retry is what succeeds", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  await createGraphForAgent(agent.id, {
    plan: plan("plan-h", [{ ...command("flaky"), retries: 2 }]),
    totalBudgetMinor: 200
  });

  const runtime = recordingRuntime({ failOn: ["flaky"], failTimes: { flaky: 1 } });

  const first = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });
  assert.equal(first.status, "retry_scheduled");
  assert.equal(first.node.status, NODE_STATUS.READY);

  const second = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });
  assert.equal(second.status, "succeeded");
  assert.equal(second.node.attempt, 2);
  assert.deepEqual(runtime.calls, ["flaky", "flaky"]);
});

test("an unclassified failure is not retried", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  await createGraphForAgent(agent.id, {
    plan: plan("plan-i", [{ ...command("broken"), retries: 5 }])
  });

  // failTimes absent means the runtime does not mark it retryable.
  const runtime = recordingRuntime({ failOn: ["broken"] });
  const result = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "failed");
  assert.equal(result.node.status, NODE_STATUS.FAILED);
  assert.deepEqual(runtime.calls, ["broken"], "one attempt, not six");
});

test("a failed node buries everything downstream and the drain stops there", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  await createGraphForAgent(agent.id, {
    plan: plan("plan-j", [command("install", ["install"]), command("test"), command("build", ["run", "build"])])
  });

  const runtime = recordingRuntime({ failOn: ["install"] });
  const result = await drainGraph({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "failed");
  assert.deepEqual(runtime.calls, ["install"], "nothing downstream ran");

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  assert.equal(view.nodes.find(n => n.key === "install").status, NODE_STATUS.FAILED);
  assert.equal(view.nodes.find(n => n.key === "test").status, NODE_STATUS.SKIPPED);
  assert.equal(view.nodes.find(n => n.key === "build").status, NODE_STATUS.SKIPPED);
});

test("a full drain runs every node once, in dependency order", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  await createGraphForAgent(agent.id, {
    plan: plan("plan-k", [
      write("pkg", "package.json"),
      write("src", "index.js"),
      command("test"),
      command("build", ["run", "build"])
    ])
  });

  const runtime = recordingRuntime();
  const result = await drainGraph({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "completed");
  assert.equal(runtime.calls.length, 4);
  assert.ok(runtime.calls.indexOf("test") > runtime.calls.indexOf("pkg"));
  assert.ok(runtime.calls.indexOf("build") > runtime.calls.indexOf("test"));

  const db = await loadDb();
  const run = db.executionRuns.find(item => item.kind === "jev_graph" && item.id === result.runId);
  assert.equal(run.status, "completed");
});

test("cancelling a graph stops the drain and releases nothing half-held", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20 });
  const { graph } = await createGraphForAgent(agent.id, {
    plan: plan("plan-l", [command("one"), command("two")])
  });

  await cancelGraph({ graphId: graph.id, reason: "operator stopped the task" });

  const runtime = recordingRuntime();
  const result = await drainGraph({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "cancelled");
  assert.deepEqual(runtime.calls, []);

  const db = await loadDb();
  assert.equal(
    db.billingReservations.filter(r => r.agentInstanceId === agent.id && r.status === "reserved").length,
    0,
    "a cancelled graph leaves no budget held"
  );
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test("one tenant's worker cannot claim another tenant's node", async () => {
  const a = await makeTask({ tenantId: "tenant-one", userId: "u1", budget: 20 });
  await createGraphForAgent(a.agent.id, { plan: plan("plan-m", [command("test")]) });

  assert.equal(
    await claimNextNode({ taskId: a.task.id, tenantId: "tenant-two", workerId: "intruder" }),
    null
  );
  const mine = await claimNextNode({ taskId: a.task.id, tenantId: "tenant-one", workerId: "owner" });
  assert.ok(mine);
});

test("a graph read from the wrong tenant returns nothing", async () => {
  const a = await makeTask({ tenantId: "tenant-three", userId: "u3", budget: 20 });
  await createGraphForAgent(a.agent.id, { plan: plan("plan-n", [command("test")]) });

  assert.equal(await graphForTask({ taskId: a.task.id, tenantId: "tenant-four" }), null);
  assert.ok(await graphForTask({ taskId: a.task.id, tenantId: "tenant-three" }));
});

// ── Tool scope enforcement at the broker ─────────────────────────────────────

function brokerWithTool(toolKey, execute) {
  const registry = new ToolAdapterRegistry();
  registry.register(toolKey, { execute });
  return new ToolBroker({ registry });
}

test("a tool call outside the node's declared scope never reaches the adapter", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20, toolScopes: ["workspace:read", "workspace:write", "process:execute", "git:read", "git:write"] });
  // A file-write node. It declares filesystem only.
  await createGraphForAgent(agent.id, { plan: plan("plan-o", [write("w", "a.js")]) });
  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  const node = view.nodes.find(n => n.key === "w");
  assert.deepEqual(node.toolScopes, ["filesystem:workspace:write"]);

  let reached = false;
  const broker = brokerWithTool("shell", async () => { reached = true; return { ok: true }; });

  const result = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "shell",
    scopes: ["process:execute"],
    nodeId: node.id
  });

  assert.equal(result.allowed, false);
  assert.equal(result.scopeDenied, true);
  assert.equal(reached, false, "the adapter was never called");
});

test("a denied scope is audited as a failure, not a successful tool call", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20, toolScopes: ["workspace:read", "workspace:write", "process:execute", "git:read", "git:write"] });
  await createGraphForAgent(agent.id, { plan: plan("plan-p", [write("w", "a.js")]) });
  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  const node = view.nodes.find(n => n.key === "w");

  const broker = brokerWithTool("shell", async () => ({ ok: true }));
  const result = await broker.invoke({
    agentInstanceId: agent.id, toolKey: "shell", scopes: ["process:execute"], nodeId: node.id
  });

  const db = await loadDb();
  const call = db.toolCalls.find(item => item.id === result.audit.id);
  assert.equal(call.status, "scope_denied");
  assert.equal(call.nodeId, node.id);

  const audit = db.auditLogs.find(entry => entry.resourceId === result.audit.id);
  assert.equal(audit.outcome, "failed", "a refusal is not a success");
});

test("a tool call inside the node's declared scope is allowed through", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20, toolScopes: ["workspace:read", "workspace:write", "process:execute", "git:read", "git:write"] });
  await createGraphForAgent(agent.id, { plan: plan("plan-q", [write("w", "a.js")]) });
  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  const node = view.nodes.find(n => n.key === "w");

  let reached = false;
  const broker = brokerWithTool("filesystem", async () => { reached = true; return { ok: true }; });

  const result = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "filesystem",
    scopes: ["workspace:write"],
    nodeId: node.id
  });

  assert.equal(result.allowed, true);
  assert.equal(reached, true);
});

test("a call with no scopes cannot slip past the narrowing by requesting everything", async () => {
  const { agent, tenantId } = await makeTask({ budget: 20, toolScopes: ["workspace:read", "workspace:write", "process:execute", "git:read", "git:write"] });
  // A git command node declares git only — never the filesystem's full set.
  await createGraphForAgent(agent.id, {
    plan: plan("plan-r", [{ id: "g", kind: APP_WEB_STEP_KINDS.COMMAND, executable: "git", args: ["init"] }])
  });
  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  const node = view.nodes.find(n => n.key === "g");

  let reached = false;
  const broker = brokerWithTool("filesystem", async () => { reached = true; return { ok: true }; });

  // No `scopes` argument: authorizeToolCall expands this to every scope the
  // filesystem tool has, and the narrowing must still catch it.
  const result = await broker.invoke({
    agentInstanceId: agent.id, toolKey: "filesystem", nodeId: node.id
  });

  assert.equal(result.allowed, false);
  assert.equal(reached, false);
});

test("a node id from another task cannot be borrowed to widen scope", async () => {
  const a = await makeTask({ tenantId: "tenant-five", userId: "u5", budget: 20, toolScopes: ["process:execute"] });
  const b = await makeTask({ tenantId: "tenant-six", userId: "u6", budget: 20, toolScopes: ["process:execute"] });

  await createGraphForAgent(b.agent.id, {
    plan: plan("plan-s", [command("wide")])
  });
  const otherView = await graphForTask({ taskId: b.task.id, tenantId: "tenant-six" });
  const otherNode = otherView.nodes.find(n => n.key === "wide");

  const broker = brokerWithTool("shell", async () => ({ ok: true }));
  await assert.rejects(
    () => broker.invoke({
      agentInstanceId: a.agent.id,
      toolKey: "shell",
      scopes: ["process:execute"],
      nodeId: otherNode.id
    }),
    /does not belong to this agent's task/
  );
});
