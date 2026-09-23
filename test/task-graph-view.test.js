import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The graph, as something a person can look at.
//
// Two properties matter and they are in tension. It must be the REAL graph —
// real nodes, real statuses, real edges — because a diagram that does not
// correspond to what is executing is worse than none, since it is believed.
// And it must not carry the payload, which is where a pasted token or a
// connection string would be.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-graphview-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-graphview-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { transact, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { createTaskGraph, claimNextNode, completeNode, failNode } = await import("../src/jev.js");
const { taskGraphView } = await import("../src/task-graph-view.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

const SECRET = "REDACTION-CANARY-must-never-be-shown";

let seq = 0;
async function makeGraph() {
  seq += 1;
  const tenantId = "tenant-graphview-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "graphview-user",
    taskType: "website",
    title: "Graph " + seq,
    originalRequest: "Build it",
    specification: "Build it",
    requestedTools: ["filesystem"],
    estimatedBudget: 1,
    maxBudget: 50,
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

  const created = await createTaskGraph({
    tenantId,
    userId: task.userId,
    taskId: task.id,
    agentInstanceId: agent.id,
    nodes: [
      {
        key: "astra-plan",
        kind: "model_plan",
        dependsOn: [],
        // The payload is where a secret would be, so the fixture puts one here.
        payload: { prompt: "Plan it", apiKey: SECRET },
        budgetMinor: 180,
        toolScopes: []
      },
      {
        key: "exec1:write",
        kind: "workspace_write_file",
        dependsOn: ["astra-plan"],
        payload: { kind: "workspace_write_file", path: "a.txt", content: SECRET },
        toolScopes: []
      },
      {
        key: "astra-review-1",
        kind: "model_review",
        dependsOn: ["exec1:write"],
        payload: { prompt: "Review it" },
        budgetMinor: 144,
        toolScopes: []
      }
    ]
  });

  return { task, agent, tenantId, graph: created.graph };
}

test("the view is the real graph: real nodes, real statuses, real edges", async () => {
  const { task, tenantId } = await makeGraph();

  const claim = await claimNextNode({ taskId: task.id, tenantId, workerId: "w1" });
  await completeNode({
    nodeId: claim.node.id,
    leaseId: claim.node.leaseId,
    output: { costMinor: 3, structured: { plan: { steps: [] } } }
  });

  const view = await taskGraphView({ taskId: task.id, tenantId });

  assert.equal(view.totals.nodes, 3);
  assert.deepEqual(view.nodes.map(node => node.key), ["astra-plan", "exec1:write", "astra-review-1"]);

  const plan = view.nodes[0];
  assert.equal(plan.status, "succeeded");
  assert.equal(plan.attempt, 1);
  assert.equal(plan.isModelPhase, true);
  assert.equal(plan.phase, "Planning");
  // The edge is the node's own dependency list, not something drawn for effect.
  assert.deepEqual(view.nodes[1].dependsOn, ["astra-plan"]);
  assert.deepEqual(view.nodes[2].dependsOn, ["exec1:write"]);

  // Reserved and actual are both reported, because the difference is the
  // interesting part: this is the budget working, not an arbitrary number.
  assert.equal(plan.cost.reserved, 1.8);
  assert.equal(plan.cost.actual, 0.03);
  assert.equal(view.totals.reserved, 3.24);
});

test("the payload never leaves the projection", async () => {
  const { task, tenantId } = await makeGraph();
  const view = await taskGraphView({ taskId: task.id, tenantId });

  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(SECRET), "a node payload reached the view");
  assert.ok(!serialized.includes("payload"), "the payload field itself was projected");
});

test("a failure says what failed, and what it took down with it", async () => {
  const { task, tenantId } = await makeGraph();

  const first = await claimNextNode({ taskId: task.id, tenantId, workerId: "w1" });
  await failNode({
    nodeId: first.node.id,
    leaseId: first.node.leaseId,
    error: new Error("the planner refused"),
    retryable: false
  });

  const view = await taskGraphView({ taskId: task.id, tenantId });

  assert.equal(view.status, "failed");
  const plan = view.nodes.find(node => node.key === "astra-plan");
  assert.equal(plan.status, "failed");
  assert.equal(plan.error, "the planner refused");

  // "Why did this never run" is a question people ask of a graph, and SKIPPED
  // on its own does not answer it.
  const skipped = view.nodes.find(node => node.key === "exec1:write");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.skippedBecause, "astra-plan");
  assert.equal(view.counts.skipped, 2);
});

test("a running node says who is holding it", async () => {
  const { task, tenantId } = await makeGraph();
  await claimNextNode({ taskId: task.id, tenantId, workerId: "worker-7", leaseMs: 60_000 });

  const view = await taskGraphView({ taskId: task.id, tenantId });
  const running = view.nodes.find(node => node.status === "running");

  // Useful precisely when a task looks stuck.
  assert.equal(running.runningOn, "worker-7");
  assert.ok(running.leaseExpiresAt);
});

test("a task with no graph yet is reported as such rather than invented", async () => {
  const view = await taskGraphView({ taskId: "task_does_not_exist", tenantId: "nobody" });
  assert.equal(view, null);
});
