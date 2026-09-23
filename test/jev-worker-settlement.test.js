import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// What happens to the money when a worker dies.
//
// The node is recovered and run again — that part was already proven. What was
// not proven, and was not true, is what happens to the reservation the dead
// worker was holding. It stayed open. The retry then took a SECOND reservation,
// so a task whose worker died three times held three reservations against a
// budget it never spent; and because reserveSpend counts concurrent
// reservations, the task eventually starved itself on money it never used.
//
// Nothing surfaced it, because every individual piece behaved correctly. The
// node recovered. The retry succeeded. The task finished. The ledger simply had
// holds in it that would never be settled.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-settle-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-settle-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { createTaskGraph, claimNextNode, sweepStalledNodes, graphForTask } = await import("../src/jev.js");
const { runWorker } = await import("../src/jev-worker.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeGraph({ budgetMinor = 500, maxAttempts = 3 } = {}) {
  seq += 1;
  const tenantId = "tenant-settle-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "settle-user",
    taskType: "website",
    title: "Settlement " + seq,
    originalRequest: "Build it",
    specification: "Build it",
    requestedTools: ["filesystem"],
    estimatedBudget: 1,
    maxBudget: 20,
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
    nodes: [{
      key: "paid-work",
      kind: "workspace_write_file",
      description: "write a file that costs money",
      dependsOn: [],
      payload: { id: "paid-work", kind: "workspace_write_file", path: "out.txt", content: "done" },
      budgetMinor,
      maxAttempts,
      toolScopes: []
    }]
  });

  return { task, agent, tenantId, node: created.nodes[0] };
}

function reservationsFor(db, agentId) {
  return db.billingReservations.filter(item => item.agentInstanceId === agentId);
}

test("a worker that dies releases the budget it was holding", async () => {
  const { agent, tenantId, node } = await makeGraph({ budgetMinor: 500 });

  // A worker claims it and reserves against it, then dies. Claiming with a
  // lease already in the past is how a death looks from the database's side.
  const claim = await claimNextNode({
    taskId: agent.taskId, tenantId, workerId: "worker-that-dies", leaseMs: 1,
    now: new Date(Date.now() - 60_000)
  });
  assert.ok(claim);

  const { reserveNodeBudget } = await import("../src/jev-budget.js");
  const hold = await reserveNodeBudget({ node: claim.node, agentInstanceId: agent.id });
  assert.equal(hold.reserved, true);
  assert.equal(hold.amountMinor, 500);

  let db = await loadDb();
  assert.equal(
    reservationsFor(db, agent.id).filter(item => item.status === "reserved").length, 1,
    "the fixture did not actually hold any budget"
  );

  const swept = await sweepStalledNodes({ now: new Date() });
  assert.ok(swept.recovered.some(item => item.id === node.id), "the node was not recovered");

  db = await loadDb();
  const open = reservationsFor(db, agent.id).filter(item => item.status === "reserved");
  assert.equal(open.length, 0, "the dead worker's hold survived the sweep");

  const released = reservationsFor(db, agent.id).filter(item => item.status === "released");
  assert.equal(released.length, 1);
  assert.ok(released[0].resolvedAt, "the release left no record of when it happened");
});

test("a recovered node does not accumulate holds across attempts", async () => {
  const { agent, tenantId } = await makeGraph({ budgetMinor: 400, maxAttempts: 4 });
  const { reserveNodeBudget } = await import("../src/jev-budget.js");

  // Three deaths in a row. Before the fix this left three open holds against a
  // budget the task had not spent a penny of.
  for (let i = 0; i < 3; i += 1) {
    const claim = await claimNextNode({
      taskId: agent.taskId, tenantId, workerId: "worker-" + i, leaseMs: 1,
      now: new Date(Date.now() - 60_000)
    });
    assert.ok(claim, "nothing was claimable on attempt " + (i + 1));
    await reserveNodeBudget({ node: claim.node, agentInstanceId: agent.id });
    await sweepStalledNodes({ now: new Date() });
  }

  const db = await loadDb();
  const open = reservationsFor(db, agent.id).filter(item => item.status === "reserved");
  assert.equal(open.length, 0, open.length + " phantom holds accumulated");

  // The agent has spent nothing, because nothing ever completed.
  const current = db.agentInstances.find(item => item.id === agent.id);
  assert.equal(Number(current.budgetUsed || 0), 0, "money was charged for work that never finished");
});

test("a real worker finishes recovered work and settles it exactly once", async () => {
  const { agent, tenantId, node } = await makeGraph({ budgetMinor: 300 });

  const claim = await claimNextNode({
    taskId: agent.taskId, tenantId, workerId: "worker-that-dies", leaseMs: 1,
    now: new Date(Date.now() - 60_000)
  });
  const { reserveNodeBudget } = await import("../src/jev-budget.js");
  await reserveNodeBudget({ node: claim.node, agentInstanceId: agent.id });

  // A worker claims from ANY graph, including ones earlier tests left behind,
  // so the assertion is scoped to this node rather than to a global count.
  const stats = await runWorker({ workerId: "worker-that-lives", maxIterations: 6, pollMs: 1, sweep: true });
  assert.ok(stats.succeeded >= 1, JSON.stringify(stats));

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  const settled = view.nodes.find(item => item.key === "paid-work");
  assert.equal(settled.status, "succeeded");
  assert.equal(Number(settled.attempt), 2, "the recovery was not recorded as a second attempt");

  const db = await loadDb();
  const all = reservationsFor(db, agent.id);
  // One reservation per attempt, and every one of them settled: the first
  // released by the sweep, the second captured by the work that finished.
  assert.equal(all.length, 2, JSON.stringify(all.map(item => item.status)));
  assert.equal(all.filter(item => item.status === "reserved").length, 0);
  assert.equal(all.filter(item => item.status === "released").length, 1);
  assert.equal(all.filter(item => item.status === "captured").length, 1);

  // Charged once, for one piece of work, even though it ran twice.
  const ledger = db.billingLedger.filter(item => item.agentInstanceId === agent.id);
  assert.ok(ledger.length <= 1, "the recovered node was billed more than once");
  assert.equal(node.id, settled.id, "a different node was completed");
});
