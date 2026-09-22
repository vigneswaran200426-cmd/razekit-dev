import test from "node:test";
import assert from "node:assert/strict";

// JEV against the real production store.
//
// The JSON-backed tests in jev.test.js prove the RULES. They cannot prove the
// one property that actually matters in production, because the JSON store is
// atomic only within a single process: that two workers in two containers
// cannot be handed the same node. That is what this file is for, and it runs
// against a real Postgres — nothing here is simulated.
//
// Skipped when RAZEKIT_DATABASE_URL is absent, so CI without a database stays
// green — but the skip is announced, never silent.

const DATABASE_URL = process.env.RAZEKIT_DATABASE_URL;

if (!DATABASE_URL) {
  test("postgres JEV", { skip: "RAZEKIT_DATABASE_URL is not set" }, () => {});
}

const suite = DATABASE_URL ? test : test.skip;

process.env.RAZEKIT_STORE = "postgres";

const { NODE_STATUS, GRAPH_STATUS } = await import("../src/jev-domain.js");
const { cancelGraph, claimNextNode, completeNode, createTaskGraph, failNode, graphForTask, sweepStalledNodes } =
  await import("../src/jev.js");
const { closeStore, transact } = await import("../src/store.js");

const TENANT = "tenant-jev-pg";
const runId = Date.now().toString(36);
let created = 0;
const nextTask = () => "task-jev-pg-" + runId + "-" + (++created);

const node = (key, deps = [], extra = {}) => ({ key, dependsOn: deps, ...extra });

// Read before deleting. A cleanup that deletes graphs first and then looks for
// their nodes leaves orphaned rows behind, and orphaned rows from an earlier run
// are exactly the debris that makes a later run fail convincingly.
test.after(async () => {
  if (!DATABASE_URL) return;
  await transact(db => {
    const mine = db.taskGraphs.filter(g => g.tenantId === TENANT).map(g => g.id);
    const graphIds = new Set(mine);
    for (let i = db.graphNodes.length - 1; i >= 0; i -= 1) {
      if (graphIds.has(db.graphNodes[i].graphId)) db.graphNodes.splice(i, 1);
    }
    for (let i = db.taskGraphs.length - 1; i >= 0; i -= 1) {
      if (graphIds.has(db.taskGraphs[i].id)) db.taskGraphs.splice(i, 1);
    }
    for (let i = db.auditLogs.length - 1; i >= 0; i -= 1) {
      if (db.auditLogs[i].tenantId === TENANT) db.auditLogs.splice(i, 1);
    }
  });
  await closeStore();
});

suite("the graph collections exist in the production schema", async () => {
  const taskId = nextTask();
  const { graph, nodes } = await createTaskGraph({
    taskId, tenantId: TENANT, nodes: [node("a"), node("b", ["a"])]
  });
  assert.equal(graph.status, GRAPH_STATUS.PENDING);
  assert.equal(nodes.length, 2);

  const view = await graphForTask({ taskId, tenantId: TENANT });
  assert.equal(view.nodes.length, 2, "the graph survived the round trip to Postgres");
  assert.equal(view.nodes.find(n => n.key === "a").status, NODE_STATUS.READY);
  assert.equal(view.nodes.find(n => n.key === "b").status, NODE_STATUS.PENDING);
});

suite("six concurrent workers claim four parallel nodes exactly once each", async () => {
  const taskId = nextTask();
  // One root, then four independent branches. All four open at the same moment,
  // which is the window in which a duplicate claim would happen.
  await createTaskGraph({
    taskId,
    tenantId: TENANT,
    nodes: [
      node("root"),
      node("branch-1", ["root"]),
      node("branch-2", ["root"]),
      node("branch-3", ["root"]),
      node("branch-4", ["root"])
    ]
  });

  const root = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w-root" });
  await completeNode({ nodeId: root.node.id, leaseId: root.node.leaseId });

  // Six workers, four nodes. Two must come away with nothing rather than
  // doubling up on someone else's work.
  const claims = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      claimNextNode({ taskId, tenantId: TENANT, workerId: "w-" + i, leaseMs: 120_000 })
    )
  );

  const won = claims.filter(Boolean);
  assert.equal(won.length, 4, "four nodes were available, so four claims succeeded");
  assert.equal(claims.filter(c => c === null).length, 2, "the two extra workers were told no");

  const keys = won.map(c => c.node.key).sort();
  assert.deepEqual(keys, ["branch-1", "branch-2", "branch-3", "branch-4"]);
  assert.equal(new Set(won.map(c => c.node.id)).size, 4, "no node was handed out twice");
  assert.equal(new Set(won.map(c => c.node.leaseId)).size, 4, "every claim got its own lease");
  for (const claim of won) assert.equal(claim.node.attempt, 1, "no node was claimed twice");
});

suite("a dependent is never claimable until its dependencies actually succeeded", async () => {
  const taskId = nextTask();
  await createTaskGraph({
    taskId, tenantId: TENANT,
    nodes: [node("left"), node("right"), node("join", ["left", "right"])]
  });

  const first = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w1", leaseMs: 120_000 });
  const second = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w2", leaseMs: 120_000 });
  assert.deepEqual([first.node.key, second.node.key].sort(), ["left", "right"]);

  // Only one half done: the join must still be refused.
  await completeNode({ nodeId: first.node.id, leaseId: first.node.leaseId });
  assert.equal(
    await claimNextNode({ taskId, tenantId: TENANT, workerId: "w3" }), null,
    "the join is not claimable while one dependency is still running"
  );

  await completeNode({ nodeId: second.node.id, leaseId: second.node.leaseId });
  const join = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w3", leaseMs: 120_000 });
  assert.equal(join.node.key, "join");
});

suite("a worker that dies has its node recovered, and cannot report back afterwards", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, tenantId: TENANT, nodes: [node("work", [], { maxAttempts: 3 })] });

  // A short lease stands in for a container that was killed mid-step.
  const dead = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w-dead", leaseMs: 1000 });
  const staleLease = dead.node.leaseId;

  const later = new Date(Date.now() + 10_000);
  const swept = await sweepStalledNodes({ now: later, tenantId: TENANT });
  assert.deepEqual(swept.recovered.map(r => r.key), ["work"]);

  const live = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w-live", now: later, leaseMs: 120_000 });
  assert.equal(live.node.id, dead.node.id);
  assert.equal(live.node.attempt, 2);
  await completeNode({ nodeId: live.node.id, leaseId: live.node.leaseId, output: { by: "w-live" } });

  const zombie = await completeNode({ nodeId: dead.node.id, leaseId: staleLease, output: { by: "w-dead" } });
  assert.equal(zombie.accepted, false);
  assert.deepEqual(zombie.node.output, { by: "w-live" }, "the dead worker did not overwrite the real result");
});

suite("a terminal failure buries its dependents durably", async () => {
  const taskId = nextTask();
  await createTaskGraph({
    taskId, tenantId: TENANT,
    nodes: [
      node("build", [], { maxAttempts: 1 }),
      node("test", ["build"]),
      node("package", ["test"]),
      node("publish", ["package"])
    ]
  });

  const build = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w", leaseMs: 120_000 });
  const failed = await failNode({
    nodeId: build.node.id, leaseId: build.node.leaseId,
    error: "compilation failed", retryable: true
  });
  assert.equal(failed.willRetry, false, "maxAttempts of 1 means the first failure is terminal");

  // Re-read from the database rather than trusting the in-memory return value.
  const view = await graphForTask({ taskId, tenantId: TENANT, includeFinished: true });
  const status = key => view.nodes.find(n => n.key === key).status;
  assert.equal(status("build"), NODE_STATUS.FAILED);
  assert.equal(status("test"), NODE_STATUS.SKIPPED);
  assert.equal(status("package"), NODE_STATUS.SKIPPED);
  assert.equal(status("publish"), NODE_STATUS.SKIPPED);
  assert.equal(view.graph.status, GRAPH_STATUS.FAILED);

  assert.equal(await claimNextNode({ taskId, tenantId: TENANT, workerId: "w" }), null);
});

suite("another tenant can neither read nor claim this graph", async () => {
  const taskId = nextTask();
  await createTaskGraph({ taskId, tenantId: TENANT, nodes: [node("private")] });

  assert.equal(await graphForTask({ taskId, tenantId: "tenant-somebody-else" }), null);
  assert.equal(await claimNextNode({ taskId, tenantId: "tenant-somebody-else", workerId: "w" }), null);

  const mine = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w", leaseMs: 120_000 });
  assert.equal(mine.node.key, "private");
});

suite("cancellation is durable and voids work in flight", async () => {
  const taskId = nextTask();
  const { graph } = await createTaskGraph({
    taskId, tenantId: TENANT, nodes: [node("a"), node("b", ["a"])]
  });
  const claim = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w", leaseMs: 120_000 });

  await cancelGraph({ graphId: graph.id, reason: "operator stopped the task" });

  const late = await completeNode({ nodeId: claim.node.id, leaseId: claim.node.leaseId });
  assert.equal(late.accepted, false);

  const view = await graphForTask({ taskId, tenantId: TENANT, includeFinished: true });
  assert.equal(view.graph.status, GRAPH_STATUS.CANCELLED);
  assert.ok(view.nodes.every(n => n.status === NODE_STATUS.CANCELLED));
});

// ── Konami ───────────────────────────────────────────────────────────────────

suite("a Konami game graph persists and schedules on the production store", async () => {
  const taskId = nextTask();
  const { GAME_STEP_KINDS, GAME_ENGINES } = await import("../src/game-domain.js");
  const { graphFromExecutionPlan } = await import("../src/jev-planner.js");

  // Built through the real planner from a real game plan, so this exercises the
  // game contract rather than hand-written nodes that happen to look like one.
  const nodes = graphFromExecutionPlan({
    id: "pg-game-plan",
    version: 1,
    engine: GAME_ENGINES.GODOT,
    steps: [
      { id: "init", kind: GAME_STEP_KINDS.PROJECT_INIT, engine: GAME_ENGINES.GODOT, path: "game" },
      { id: "scene", kind: GAME_STEP_KINDS.ASSET_WRITE, path: "game/Main.tscn", content: "x" },
      { id: "script", kind: GAME_STEP_KINDS.ASSET_WRITE, path: "game/Player.gd", content: "x" },
      { id: "playtest", kind: GAME_STEP_KINDS.PLAYTEST, checks: ["boots"] },
      { id: "build", kind: GAME_STEP_KINDS.BUILD, target: "development" }
    ]
  }, { taskType: "game" });

  await createTaskGraph({ taskId, tenantId: TENANT, nodes });

  const view = await graphForTask({ taskId, tenantId: TENANT });
  assert.equal(view.nodes.length, 5, "the game graph survived the round trip to Postgres");

  // The engine travelled into storage with the nodes — a build node read back
  // from the database has to know which engine to build.
  assert.equal(view.nodes.find(n => n.key === "build").payload.engine, GAME_ENGINES.GODOT);
  // Game tool scopes persisted too.
  assert.ok(view.nodes.find(n => n.key === "playtest").toolScopes.some(x => x.startsWith("game-playtest:")));

  // Only the project init is claimable; the two assets wait behind it.
  assert.equal(view.nodes.find(n => n.key === "init").status, NODE_STATUS.READY);
  assert.equal(view.nodes.find(n => n.key === "scene").status, NODE_STATUS.PENDING);

  const init = await claimNextNode({ taskId, tenantId: TENANT, workerId: "w-game", leaseMs: 120_000 });
  assert.equal(init.node.key, "init");
  await completeNode({ nodeId: init.node.id, leaseId: init.node.leaseId });

  // Both assets open at once, and two workers take one each.
  const [a, b] = await Promise.all([
    claimNextNode({ taskId, tenantId: TENANT, workerId: "w-a", leaseMs: 120_000 }),
    claimNextNode({ taskId, tenantId: TENANT, workerId: "w-b", leaseMs: 120_000 })
  ]);
  assert.deepEqual([a.node.key, b.node.key].sort(), ["scene", "script"]);
  assert.notEqual(a.node.id, b.node.id, "the same asset node was not handed out twice");

  // The playtest barrier is still refused while an asset is in flight.
  assert.equal(await claimNextNode({ taskId, tenantId: TENANT, workerId: "w-c" }), null);
});
