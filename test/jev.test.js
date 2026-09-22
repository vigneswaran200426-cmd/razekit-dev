import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A private data directory per run, chosen before the store is imported, so
// these tests never read or write the developer's own data/db.json.
const dataDir = await mkdtemp(path.join(tmpdir(), "razekit-jev-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_STORE = "json";

const {
  NODE_STATUS,
  GRAPH_STATUS,
  applyReadiness,
  assertGraphShape,
  claimableNodes,
  deriveGraphStatus,
  topologicalOrder
} = await import("../src/jev-domain.js");

const {
  cancelGraph,
  claimNextNode,
  completeNode,
  createTaskGraph,
  failNode,
  graphForTask,
  renewNodeLease,
  sweepStalledNodes
} = await import("../src/jev.js");

const { loadDb } = await import("../src/store.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// A different task id per test keeps the "one active graph per task" rule from
// making these tests depend on each other's order.
let counter = 0;
const nextTask = () => "task-jev-" + (++counter);

const node = (key, deps = [], extra = {}) => ({ key, dependsOn: deps, ...extra });

// The plan from the mandate: two implementation branches that must both finish
// before integration, and a final verification after that.
const PIPELINE = [
  node("inspect-repository"),
  node("define-architecture", ["inspect-repository"]),
  node("implement-backend", ["define-architecture"]),
  node("implement-frontend", ["define-architecture"]),
  node("test-backend", ["implement-backend"]),
  node("test-frontend", ["implement-frontend"]),
  node("integrate", ["test-backend", "test-frontend"]),
  node("final-verification", ["integrate"])
];

// ── Pure model ───────────────────────────────────────────────────────────────

test("a cycle is rejected before it can become a task that never finishes", () => {
  assert.throws(
    () => assertGraphShape([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])]),
    /dependency cycle: a, b, c/
  );
});

test("a dependency on a node that does not exist is rejected", () => {
  assert.throws(() => assertGraphShape([node("a", ["ghost"])]), /depends on unknown node: ghost/);
  assert.throws(() => assertGraphShape([node("a", ["a"])]), /depends on itself/);
  assert.throws(() => assertGraphShape([node("a"), node("a")]), /Duplicate graph node key/);
});

test("topological order is deterministic across repeated evaluation", () => {
  const first = topologicalOrder(PIPELINE.map((n, i) => ({ ...n, order: i })));
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(topologicalOrder(PIPELINE.map((n, j) => ({ ...n, order: j }))), first);
  }
  // Ordering is a constraint, not an arbitrary list: every dependency must
  // appear before the node that needs it.
  const position = new Map(first.map((key, index) => [key, index]));
  for (const n of PIPELINE) {
    for (const dep of n.dependsOn) {
      assert.ok(position.get(dep) < position.get(n.key), dep + " must precede " + n.key);
    }
  }
});

test("failure propagates transitively, not just one level", () => {
  const nodes = PIPELINE.map((n, i) => ({ ...n, order: i, status: NODE_STATUS.PENDING }));
  nodes.find(n => n.key === "inspect-repository").status = NODE_STATUS.SUCCEEDED;
  nodes.find(n => n.key === "define-architecture").status = NODE_STATUS.SUCCEEDED;
  nodes.find(n => n.key === "implement-backend").status = NODE_STATUS.FAILED;

  applyReadiness(nodes);
  const status = key => nodes.find(n => n.key === key).status;

  // Direct dependent, and then the two nodes beyond it. A single pass would
  // have left "integrate" and "final-verification" PENDING forever.
  assert.equal(status("test-backend"), NODE_STATUS.SKIPPED);
  assert.equal(status("integrate"), NODE_STATUS.SKIPPED);
  assert.equal(status("final-verification"), NODE_STATUS.SKIPPED);

  // The unaffected branch is untouched and still runnable.
  assert.equal(status("implement-frontend"), NODE_STATUS.READY);
});

test("a node is never claimable while a dependency has not succeeded", () => {
  const nodes = PIPELINE.map((n, i) => ({ ...n, order: i, status: NODE_STATUS.PENDING }));
  assert.deepEqual(claimableNodes(nodes).map(n => n.key), []);

  nodes[0].status = NODE_STATUS.READY;
  assert.deepEqual(claimableNodes(nodes).map(n => n.key), ["inspect-repository"]);

  // A stored status that disagrees with the dependencies is not trusted: the
  // dependencies are the truth and the node stays unclaimable.
  nodes.find(n => n.key === "integrate").status = NODE_STATUS.READY;
  assert.deepEqual(claimableNodes(nodes).map(n => n.key), ["inspect-repository"]);
});

test("graph status is derived from the nodes and cannot disagree with them", () => {
  const nodes = PIPELINE.map((n, i) => ({ ...n, order: i, status: NODE_STATUS.PENDING }));
  assert.equal(deriveGraphStatus(nodes), GRAPH_STATUS.PENDING);

  nodes[0].status = NODE_STATUS.RUNNING;
  assert.equal(deriveGraphStatus(nodes), GRAPH_STATUS.RUNNING);

  for (const n of nodes) n.status = NODE_STATUS.SUCCEEDED;
  assert.equal(deriveGraphStatus(nodes), GRAPH_STATUS.SUCCEEDED);

  nodes.at(-1).status = NODE_STATUS.FAILED;
  assert.equal(deriveGraphStatus(nodes), GRAPH_STATUS.FAILED);

  nodes.at(-1).status = NODE_STATUS.CANCELLED;
  assert.equal(deriveGraphStatus(nodes), GRAPH_STATUS.CANCELLED);
});

// ── Durable execution ────────────────────────────────────────────────────────

test("only the graph's sources are claimable when it is created", async () => {
  const taskId = nextTask();
  const { graph, nodes } = await createTaskGraph({ taskId, nodes: PIPELINE });

  assert.equal(graph.status, GRAPH_STATUS.PENDING);
  assert.deepEqual(
    nodes.filter(n => n.status === NODE_STATUS.READY).map(n => n.key),
    ["inspect-repository"]
  );
  assert.equal(nodes.filter(n => n.status === NODE_STATUS.PENDING).length, 7);
});

test("a task may not hold two active graphs at once", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE });
  await assert.rejects(
    () => createTaskGraph({ taskId, nodes: PIPELINE }),
    /already has an active execution graph/
  );
});

test("two workers never receive the same node", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE });

  const [a, b] = await Promise.all([
    claimNextNode({ taskId, workerId: "worker-a" }),
    claimNextNode({ taskId, workerId: "worker-b" })
  ]);

  const claims = [a, b].filter(Boolean);
  assert.equal(claims.length, 1, "exactly one worker gets the only ready node");
  assert.equal(claims[0].node.key, "inspect-repository");
  assert.equal(claims[0].node.attempt, 1);
  assert.ok(claims[0].node.leaseId);
});

test("completing a node releases exactly what it unblocks, and nothing further", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE });

  const claim = await claimNextNode({ taskId, workerId: "worker-a" });
  const done = await completeNode({ nodeId: claim.node.id, leaseId: claim.node.leaseId, output: { ok: true } });
  assert.equal(done.accepted, true);
  assert.deepEqual(done.unblocked.map(c => c.key), ["define-architecture"]);

  const next = await claimNextNode({ taskId, workerId: "worker-a" });
  assert.equal(next.node.key, "define-architecture");
  const arch = await completeNode({ nodeId: next.node.id, leaseId: next.node.leaseId });

  // Both branches open at once — this is the point of a graph over a list.
  assert.deepEqual(
    arch.unblocked.map(c => c.key).sort(),
    ["implement-backend", "implement-frontend"]
  );
});

test("a stale worker cannot overwrite the result of the worker that replaced it", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE });

  const first = await claimNextNode({ taskId, workerId: "worker-dead", leaseMs: 1000 });
  const staleLease = first.node.leaseId;

  // The worker stops reporting; its lease expires and the node is recovered.
  const later = new Date(Date.now() + 5000);
  const swept = await sweepStalledNodes({ now: later });
  assert.equal(swept.recovered.length, 1);

  const second = await claimNextNode({ taskId, workerId: "worker-live", now: later });
  assert.equal(second.node.id, first.node.id);
  assert.notEqual(second.node.leaseId, staleLease);
  await completeNode({ nodeId: second.node.id, leaseId: second.node.leaseId, output: { by: "worker-live" } });

  // The original worker wakes up and reports. It must be refused.
  const zombie = await completeNode({ nodeId: first.node.id, leaseId: staleLease, output: { by: "worker-dead" } });
  assert.equal(zombie.accepted, false);
  assert.equal(zombie.reason, "lease-not-current");
  assert.deepEqual(zombie.node.output, { by: "worker-live" });
});

test("completing twice with the same lease is idempotent", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE });
  const claim = await claimNextNode({ taskId, workerId: "worker-a" });

  const first = await completeNode({ nodeId: claim.node.id, leaseId: claim.node.leaseId, output: { n: 1 } });
  const again = await completeNode({ nodeId: claim.node.id, leaseId: claim.node.leaseId, output: { n: 2 } });

  assert.equal(first.accepted, true);
  assert.equal(again.accepted, true);
  assert.equal(again.repeated, true);
  assert.deepEqual(again.node.output, { n: 1 }, "the retry did not overwrite the recorded output");
});

test("a retryable failure returns the node to the queue; an exhausted one buries the branch", async () => {
  const taskId = nextTask();
  await createTaskGraph({
    taskId,
    nodes: PIPELINE.map(n => (n.key === "inspect-repository" ? { ...n, maxAttempts: 2 } : n))
  });

  const a = await claimNextNode({ taskId, workerId: "w" });
  const firstFail = await failNode({ nodeId: a.node.id, leaseId: a.node.leaseId, error: "flaky", retryable: true });
  assert.equal(firstFail.willRetry, true);
  assert.equal(firstFail.node.status, NODE_STATUS.READY);
  assert.equal(firstFail.node.leaseId, null, "the failing worker holds no claim on the retry");

  const b = await claimNextNode({ taskId, workerId: "w" });
  assert.equal(b.node.attempt, 2);
  const secondFail = await failNode({ nodeId: b.node.id, leaseId: b.node.leaseId, error: "flaky", retryable: true });

  assert.equal(secondFail.willRetry, false, "attempts are exhausted at maxAttempts");
  assert.equal(secondFail.node.status, NODE_STATUS.FAILED);
  // Everything downstream of the root is now unreachable, and says so.
  assert.equal(secondFail.skipped.length, 7);
  assert.equal(secondFail.graph.status, GRAPH_STATUS.FAILED);
});

test("a non-retryable failure is not retried even with attempts remaining", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE.map(n => ({ ...n, maxAttempts: 5 })) });

  const claim = await claimNextNode({ taskId, workerId: "w" });
  const failed = await failNode({
    nodeId: claim.node.id, leaseId: claim.node.leaseId,
    error: "budget exhausted", retryable: false
  });

  assert.equal(failed.willRetry, false);
  assert.equal(failed.node.status, NODE_STATUS.FAILED);
  assert.equal(failed.node.attempt, 1, "one attempt, not five");
});

test("a node past its own deadline is terminal, not retried", async () => {
  const taskId = nextTask();
  await createTaskGraph({
    taskId,
    nodes: PIPELINE.map(n => (n.key === "inspect-repository" ? { ...n, timeoutMs: 1000, maxAttempts: 5 } : n))
  });

  const claim = await claimNextNode({ taskId, workerId: "w", leaseMs: 60_000 });
  assert.ok(claim.node.deadlineAt);

  // The sweep is deliberately global — it recovers every worker that stopped
  // reporting, not only this task's — so assert about THIS node rather than
  // about a total that other tasks in the store legitimately contribute to.
  const swept = await sweepStalledNodes({ now: new Date(Date.now() + 90_000) });
  assert.deepEqual(swept.timedOut.filter(t => t.id === claim.node.id).map(t => t.key), ["inspect-repository"]);
  assert.equal(
    swept.recovered.filter(r => r.id === claim.node.id).length, 0,
    "a slow node is not recovered as if its worker had died"
  );

  const view = await graphForTask({ taskId, tenantId: "local-tenant", includeFinished: true });
  const root = view.nodes.find(n => n.key === "inspect-repository");
  assert.equal(root.status, NODE_STATUS.TIMED_OUT);
  assert.equal(view.graph.status, GRAPH_STATUS.FAILED);
});

test("a lease can be renewed by its holder and by nobody else", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE });
  const claim = await claimNextNode({ taskId, workerId: "w", leaseMs: 1000 });

  const renewed = await renewNodeLease({ nodeId: claim.node.id, leaseId: claim.node.leaseId, leaseMs: 60_000 });
  assert.equal(renewed.renewed, true);

  const impostor = await renewNodeLease({ nodeId: claim.node.id, leaseId: "lease_not-mine", leaseMs: 60_000 });
  assert.equal(impostor.renewed, false);

  // The renewal was real: the sweep that would have reclaimed it now does not.
  const swept = await sweepStalledNodes({ now: new Date(Date.now() + 5000) });
  assert.equal(swept.recovered.filter(r => r.id === claim.node.id).length, 0);
});

test("cancelling a graph settles every node and voids work in flight", async () => {
  const taskId = nextTask();
  const created = await createTaskGraph({ taskId, nodes: PIPELINE });
  const claim = await claimNextNode({ taskId, workerId: "w" });

  const cancelled = await cancelGraph({ graphId: created.graph.id, reason: "operator stopped the task" });
  assert.equal(cancelled.cancelled.length, 8);
  assert.equal(cancelled.graph.status, GRAPH_STATUS.CANCELLED);

  const late = await completeNode({ nodeId: claim.node.id, leaseId: claim.node.leaseId, output: { ok: true } });
  assert.equal(late.accepted, false, "a cancelled graph cannot be resurrected by a late report");

  assert.equal(await claimNextNode({ taskId, workerId: "w" }), null);
});

test("a full pipeline runs to completion in dependency order", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, nodes: PIPELINE });

  const executed = [];
  for (let guard = 0; guard < 50; guard += 1) {
    const claim = await claimNextNode({ taskId, workerId: "worker-" + (guard % 3) });
    if (!claim) break;
    executed.push(claim.node.key);
    await completeNode({ nodeId: claim.node.id, leaseId: claim.node.leaseId, output: { key: claim.node.key } });
  }

  assert.equal(executed.length, 8);
  const position = new Map(executed.map((key, index) => [key, index]));
  for (const n of PIPELINE) {
    for (const dep of n.dependsOn) {
      assert.ok(position.get(dep) < position.get(n.key), dep + " ran before " + n.key);
    }
  }

  const view = await graphForTask({ taskId, tenantId: "local-tenant", includeFinished: true });
  assert.equal(view.graph.status, GRAPH_STATUS.SUCCEEDED);
  assert.equal(view.summary.complete, 8);
});

test("a graph read is scoped to its tenant", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, tenantId: "tenant-a", userId: "user-a", nodes: PIPELINE });

  const owner = await graphForTask({ taskId, tenantId: "tenant-a" });
  assert.ok(owner);

  const stranger = await graphForTask({ taskId, tenantId: "tenant-b" });
  assert.equal(stranger, null, "another tenant cannot read this graph");

  await assert.rejects(() => graphForTask({ taskId }), /requires a tenantId/);
});

test("a claim is scoped to its tenant", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, tenantId: "tenant-a", nodes: PIPELINE });

  assert.equal(await claimNextNode({ taskId, tenantId: "tenant-b", workerId: "w" }), null);
  const mine = await claimNextNode({ taskId, tenantId: "tenant-a", workerId: "w" });
  assert.ok(mine);
});

test("a GPU node is not handed to a CPU worker", async () => {
  const taskId = nextTask();
  await createTaskGraph({
    taskId,
    nodes: [node("render", [], { resourceClass: "gpu" }), node("write-log", [], { resourceClass: "cpu" })]
  });

  const cpu = await claimNextNode({ taskId, workerId: "cpu-worker", resourceClass: "cpu" });
  assert.equal(cpu.node.key, "write-log");

  const gpu = await claimNextNode({ taskId, workerId: "gpu-worker", resourceClass: "gpu" });
  assert.equal(gpu.node.key, "render");
});

test("every transition leaves an audit row", async () => {
  const taskId = nextTask();
  const created = await createTaskGraph({ taskId, nodes: [node("only")] });
  const claim = await claimNextNode({ taskId, workerId: "w" });
  await completeNode({ nodeId: claim.node.id, leaseId: claim.node.leaseId });

  const db = await loadDb();
  const actions = db.auditLogs
    .filter(entry => entry.resourceId === created.graph.id || entry.resourceId === claim.node.id)
    .map(entry => entry.action);

  assert.deepEqual(actions, ["graph.created", "graph.node.claimed", "graph.node.succeeded"]);
});

test("a node payload carrying a secret is redacted in the audit trail", async () => {
  const taskId = nextTask();
  const created = await createTaskGraph({
    taskId,
    nodes: [node("deploy", [], { payload: { apiKey: "REDACTION-CANARY-must-never-be-logged" } })]
  });

  const db = await loadDb();
  const rows = db.auditLogs.filter(entry => entry.resourceId === created.graph.id);
  assert.ok(!JSON.stringify(rows).includes("REDACTION-CANARY-must-never-be-logged"));
});
