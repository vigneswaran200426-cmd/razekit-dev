import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-konami-jev-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-konami-jev-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { id, loadDb, transact } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { NODE_STATUS, GRAPH_STATUS } = await import("../src/jev-domain.js");
const { GAME_STEP_KINDS, GAME_ENGINES } = await import("../src/game-domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { createGraphForAgent, executeNextNode, drainGraph } = await import("../src/jev-executor.js");
const { claimNextNode, graphForTask, cancelGraph } = await import("../src/jev.js");
const { profileForAgentType } = await import("../src/jev-profiles.js");
const { graphFromExecutionPlan } = await import("../src/jev-planner.js");
const { topologicalOrder } = await import("../src/jev-domain.js");
const { ToolBroker, ToolAdapterRegistry } = await import("../src/tool-broker.js");
const {
  DeterministicGameEngineAdapter,
  DeterministicGamePlaytestAdapter,
  DeterministicGamePackagerAdapter
} = await import("../src/testing-game-adapters.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;

// A Konami task and a started agent. Each gets its own tenant, because the
// tenant hourly spend ceiling is real and shared, and a money test that shares
// a tenant fails later for a reason unrelated to what it asserts.
async function makeGameTask({ tenantId = null, budget = 20, toolScopes = null } = {}) {
  tenantId = tenantId || "tenant-konami-" + (seq + 1);
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "user-konami",
    taskType: "game",
    title: "Konami JEV test " + (++seq),
    originalRequest: "Build a small godot game",
    specification: "Build a small godot game",
    requestedTools: [],
    estimatedBudget: 5,
    maxBudget: budget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "konami",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
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

const gameAdapters = () => ({
  engineAdapters: new Map([
    [GAME_ENGINES.GODOT, new DeterministicGameEngineAdapter()],
    [GAME_ENGINES.UNITY, new DeterministicGameEngineAdapter()]
  ]),
  playtestAdapter: new DeterministicGamePlaytestAdapter(),
  packagerAdapter: new DeterministicGamePackagerAdapter()
});

const gamePlan = (planId, steps, engine = GAME_ENGINES.GODOT) => ({
  id: planId, version: 1, engine, steps
});

const assetWrite = (id, p) => ({ id, kind: GAME_STEP_KINDS.ASSET_WRITE, path: p, content: "x" });
const engineAction = (id, action = "import") => ({ id, kind: GAME_STEP_KINDS.ENGINE_ACTION, action });
const playtest = (id) => ({ id, kind: GAME_STEP_KINDS.PLAYTEST, checks: ["boots"] });
const buildStep = (id) => ({ id, kind: GAME_STEP_KINDS.BUILD, target: "development" });
const packageStep = (id) => ({ id, kind: GAME_STEP_KINDS.PACKAGE, artifactName: "razekit-game" });
const projectInit = (id) => ({ id, kind: GAME_STEP_KINDS.PROJECT_INIT, engine: GAME_ENGINES.GODOT, path: "game" });

/** A runtime that records calls, so scheduling can be asserted without a disk. */
function recordingRuntime({ failOn = [], failTimes = {} } = {}) {
  const calls = [];
  const seen = new Map();
  return {
    calls,
    contexts: [],
    async execute(step, context) {
      calls.push(step.id);
      this.contexts.push(context);
      const n = (seen.get(step.id) || 0) + 1;
      seen.set(step.id, n);
      if (failOn.includes(step.id)) {
        const limit = failTimes[step.id];
        if (limit === undefined || n <= limit) {
          const error = new Error("deliberate failure in " + step.id);
          error.retryable = failTimes[step.id] !== undefined;
          throw error;
        }
      }
      return { operation: step.kind };
    }
  };
}

// ── Profile ──────────────────────────────────────────────────────────────────

test("Konami and Niomi resolve to different execution profiles", () => {
  const konami = profileForAgentType(AGENT_TYPES.KONAMI);
  const niomi = profileForAgentType(AGENT_TYPES.NIOMI);

  assert.equal(konami.taskType, "game");
  assert.equal(niomi.taskType, "app");
  assert.notEqual(konami.runKind, niomi.runKind);
  // Konami's blackboard keys stay prefixed, so moving it onto JEV does not
  // rename Niomi's state or collide with it.
  assert.equal(konami.keys.plan, "game.execution.plan");
  assert.equal(niomi.keys.plan, "execution.plan");
});

test("an unknown agent type is rejected rather than defaulting to App/Web", () => {
  assert.throws(() => profileForAgentType("something-new"), /No JEV execution profile/);
});

// ── Konami plan → JEV graph ──────────────────────────────────────────────────

test("a Konami plan becomes a graph with the game barriers honoured", () => {
  const nodes = graphFromExecutionPlan(gamePlan("g1", [
    projectInit("init"),
    assetWrite("asset-a", "game/a.png"),
    assetWrite("asset-b", "game/b.png"),
    engineAction("import"),
    playtest("playtest"),
    buildStep("build"),
    packageStep("package")
  ]), { taskType: "game" });

  const by = key => nodes.find(n => n.key === key);

  // Two independent assets are parallel; everything that observes the project
  // depends on all of it.
  assert.deepEqual(by("asset-a").dependsOn, ["init"]);
  assert.deepEqual(by("asset-b").dependsOn, ["init"]);
  assert.deepEqual(by("import").dependsOn.sort(), ["asset-a", "asset-b", "init"]);
  assert.ok(by("build").dependsOn.includes("playtest"));
  assert.ok(by("package").dependsOn.includes("build"));
});

test("game dependency ordering is topologically valid and deterministic", () => {
  const steps = [projectInit("init"), assetWrite("a", "game/a.png"), playtest("t"), buildStep("b"), packageStep("p")];
  const nodes = graphFromExecutionPlan(gamePlan("g2", steps), { taskType: "game" });
  const order = topologicalOrder(nodes);
  const at = k => order.indexOf(k);

  assert.ok(at("init") < at("a"));
  assert.ok(at("a") < at("t"));
  assert.ok(at("t") < at("b"));
  assert.ok(at("b") < at("p"));

  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(topologicalOrder(graphFromExecutionPlan(gamePlan("g2", steps), { taskType: "game" })), order);
  }
});

test("the plan's engine is stamped onto every node that did not name one", () => {
  const nodes = graphFromExecutionPlan(
    gamePlan("g3", [playtest("t"), buildStep("b"), { ...packageStep("p"), engine: GAME_ENGINES.UNITY }]),
    { taskType: "game" }
  );

  // A build node read back from the database must know which engine to build.
  assert.equal(nodes.find(n => n.key === "t").payload.engine, GAME_ENGINES.GODOT);
  assert.equal(nodes.find(n => n.key === "b").payload.engine, GAME_ENGINES.GODOT);
  // A step that named its own engine keeps it.
  assert.equal(nodes.find(n => n.key === "p").payload.engine, GAME_ENGINES.UNITY);
});

test("game step kinds get game-specific tool scopes", () => {
  const nodes = graphFromExecutionPlan(gamePlan("g4", [
    assetWrite("a", "game/a.png"), playtest("t"), buildStep("b"), engineAction("e")
  ]), { taskType: "game" });

  const scopes = key => nodes.find(n => n.key === key).toolScopes;
  assert.deepEqual(scopes("a"), ["filesystem:workspace:write"]);
  assert.ok(scopes("t").every(s => s.startsWith("game-playtest:")));
  assert.ok(scopes("b").every(s => s.startsWith("game-build:")));
  assert.ok(scopes("e").every(s => s.startsWith("engine:")));
  // A playtest node has no business executing a shell command.
  assert.ok(!scopes("t").some(s => s.startsWith("shell:")));
});

test("a Konami agent's graph is created from the game plan contract", async () => {
  const { task, agent, tenantId } = await makeGameTask();
  const { graph, nodes } = await createGraphForAgent(agent.id, {
    plan: gamePlan("g5", [projectInit("init"), playtest("t"), packageStep("p")])
  });

  assert.equal(graph.taskId, task.id);
  assert.equal(graph.planId, "g5");
  assert.equal(nodes.length, 3);

  const view = await graphForTask({ taskId: task.id, tenantId });
  assert.equal(view.nodes.find(n => n.key === "init").status, NODE_STATUS.READY);
});

test("an App/Web plan is rejected for a Konami agent", async () => {
  const { agent } = await makeGameTask();
  // No engine, and a kind the game contract does not accept.
  await assert.rejects(
    () => createGraphForAgent(agent.id, {
      plan: { id: "bad", version: 1, steps: [{ id: "s", kind: "workspace_write_file", path: "a.js", content: "x" }] }
    }),
    /engine is invalid|not valid for game/
  );
});

// ── Execution ────────────────────────────────────────────────────────────────

test("a Konami node executes through the game runtime", async () => {
  const { agent } = await makeGameTask();
  await createGraphForAgent(agent.id, { plan: gamePlan("g6", [playtest("t")]) });

  const runtime = recordingRuntime();
  const result = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(runtime.calls, ["t"]);
  // The engine reached the runtime, which is what a build step depends on.
  assert.equal(runtime.contexts[0].engine, GAME_ENGINES.GODOT);
});

test("a full Konami graph drains through real game adapters and produces an artifact", async () => {
  const { agent, tenantId } = await makeGameTask();
  await createGraphForAgent(agent.id, {
    plan: gamePlan("g7", [
      projectInit("init"),
      assetWrite("asset", "game/readme.md"),
      engineAction("import"),
      playtest("playtest"),
      buildStep("build"),
      packageStep("package")
    ])
  });

  const result = await drainGraph({
    agentInstanceId: agent.id,
    workspaceRoot: workspaceDir,
    adapters: gameAdapters()
  });

  assert.equal(result.status, "completed", "drain result: " + JSON.stringify(result.executed));
  assert.equal(result.executed.length, 6);

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  assert.equal(view.graph.status, GRAPH_STATUS.SUCCEEDED);
  assert.ok(view.nodes.every(n => n.status === NODE_STATUS.SUCCEEDED));

  // The run is recorded under the game run kind, and carries the package output
  // the dashboard's deliverables list reads.
  const db = await loadDb();
  const run = db.executionRuns.find(r => r.id === result.runId);
  assert.equal(run.kind, "jev_game_graph");
  assert.equal(run.artifacts.length, 1, "the package step produced an artifact record");
});

test("a failing Konami node is not retried when the failure is unclassified", async () => {
  const { agent } = await makeGameTask();
  await createGraphForAgent(agent.id, {
    plan: gamePlan("g8", [{ ...playtest("t"), retries: 4 }])
  });

  const runtime = recordingRuntime({ failOn: ["t"] });
  const result = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "failed");
  assert.equal(result.node.status, NODE_STATUS.FAILED);
  assert.deepEqual(runtime.calls, ["t"], "one attempt, not five");
});

test("a retryable Konami failure runs again and the retry succeeds", async () => {
  const { agent } = await makeGameTask();
  await createGraphForAgent(agent.id, {
    plan: gamePlan("g9", [{ ...buildStep("b"), retries: 2 }])
  });

  const runtime = recordingRuntime({ failOn: ["b"], failTimes: { b: 1 } });

  const first = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });
  assert.equal(first.status, "retry_scheduled");
  assert.equal(first.node.status, NODE_STATUS.READY);

  const second = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });
  assert.equal(second.status, "succeeded");
  assert.equal(second.node.attempt, 2);
  assert.deepEqual(runtime.calls, ["b", "b"]);
});

test("a failed game node buries everything downstream of it", async () => {
  const { agent, tenantId } = await makeGameTask();
  await createGraphForAgent(agent.id, {
    plan: gamePlan("g10", [projectInit("init"), playtest("t"), buildStep("b"), packageStep("p")])
  });

  const runtime = recordingRuntime({ failOn: ["t"] });
  const result = await drainGraph({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "failed");
  assert.deepEqual(runtime.calls, ["init", "t"], "the build never ran");

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  const status = k => view.nodes.find(n => n.key === k).status;
  assert.equal(status("t"), NODE_STATUS.FAILED);
  assert.equal(status("b"), NODE_STATUS.SKIPPED);
  assert.equal(status("p"), NODE_STATUS.SKIPPED);
});

test("cancelling a Konami graph stops the drain and leaves no budget held", async () => {
  const { agent } = await makeGameTask();
  const { graph } = await createGraphForAgent(agent.id, {
    plan: gamePlan("g11", [playtest("t"), buildStep("b")]),
    totalBudgetMinor: 400
  });

  await cancelGraph({ graphId: graph.id, reason: "operator stopped the task" });

  const runtime = recordingRuntime();
  const result = await drainGraph({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "cancelled");
  assert.deepEqual(runtime.calls, []);

  const db = await loadDb();
  assert.equal(
    db.billingReservations.filter(r => r.agentInstanceId === agent.id && r.status === "reserved").length,
    0
  );
});

// ── Budget ───────────────────────────────────────────────────────────────────

test("a Konami node reserves budget before it runs and settles after", async () => {
  const { agent } = await makeGameTask({ budget: 10 });
  await createGraphForAgent(agent.id, {
    plan: gamePlan("g12", [playtest("t")]),
    totalBudgetMinor: 1000
  });

  const runtime = recordingRuntime();
  await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  const db = await loadDb();
  const reservation = db.billingReservations.find(r => r.agentInstanceId === agent.id);
  assert.ok(reservation, "a reservation was taken on the existing billing system");
  assert.equal(reservation.status, "captured");
  assert.equal(reservation.category, "execution");
});

test("a Konami node that cannot be afforded never reaches the game runtime", async () => {
  const { agent } = await makeGameTask({ budget: 10 });
  await createGraphForAgent(agent.id, {
    plan: gamePlan("g13", [buildStep("b"), packageStep("p")]),
    totalBudgetMinor: 1000
  });
  await transact(db => {
    db.agentInstances.find(a => a.id === agent.id).budgetUsed = 9.95;
  });

  const runtime = recordingRuntime();
  const result = await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir });

  assert.equal(result.status, "budget_refused");
  assert.deepEqual(runtime.calls, [], "no engine work happened");
  assert.equal(result.node.status, NODE_STATUS.FAILED);
  assert.ok(result.skipped.some(s => s.key === "p"));
});

// ── Concurrency ──────────────────────────────────────────────────────────────

test("two workers draining one Konami graph never execute the same node", async () => {
  const { agent } = await makeGameTask();
  await createGraphForAgent(agent.id, {
    plan: gamePlan("g14", [
      projectInit("init"),
      assetWrite("a", "game/a.png"),
      assetWrite("b", "game/b.png"),
      assetWrite("c", "game/c.png")
    ])
  });

  const runtime = recordingRuntime();
  await executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir, workerId: "w0" });

  const claims = await Promise.all([
    executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir, workerId: "w1" }),
    executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir, workerId: "w2" }),
    executeNextNode({ agentInstanceId: agent.id, runtime, workspaceRoot: workspaceDir, workerId: "w3" })
  ]);

  const keys = claims.filter(Boolean).map(c => c.node.key).sort();
  assert.deepEqual(keys, ["a", "b", "c"]);
  assert.equal(new Set(runtime.calls).size, runtime.calls.length, "no step ran twice");
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test("another tenant can neither read nor claim a Konami graph", async () => {
  const { task, agent, tenantId } = await makeGameTask();
  await createGraphForAgent(agent.id, { plan: gamePlan("g15", [playtest("t")]) });

  assert.equal(await graphForTask({ taskId: task.id, tenantId: "tenant-intruder" }), null);
  assert.equal(await claimNextNode({ taskId: task.id, tenantId: "tenant-intruder", workerId: "w" }), null);
  assert.ok(await claimNextNode({ taskId: task.id, tenantId, workerId: "w" }));
});

// ── Tool scope enforcement ───────────────────────────────────────────────────

test("a Konami node cannot reach a tool outside its declared game scopes", async () => {
  const { agent, tenantId } = await makeGameTask({
    toolScopes: ["process:execute", "workspace:read", "workspace:write"]
  });
  await createGraphForAgent(agent.id, { plan: gamePlan("g16", [playtest("t")]) });
  const view = await graphForTask({ taskId: agent.taskId, tenantId });
  const node = view.nodes.find(n => n.key === "t");

  let reached = false;
  const registry = new ToolAdapterRegistry();
  registry.register("shell", { execute: async () => { reached = true; return { ok: true }; } });
  const broker = new ToolBroker({ registry });

  // A playtest node declares game-playtest scopes only.
  const result = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "shell",
    scopes: ["process:execute"],
    nodeId: node.id
  });

  assert.equal(result.allowed, false);
  assert.equal(result.scopeDenied, true);
  assert.equal(reached, false, "the shell adapter was never called");

  const db = await loadDb();
  const audit = db.auditLogs.find(e => e.resourceId === result.audit.id);
  assert.equal(audit.outcome, "failed");
});

test("a Konami node id cannot be borrowed by another task's agent", async () => {
  const a = await makeGameTask({ tenantId: "tenant-konami-x", toolScopes: ["process:execute"] });
  const b = await makeGameTask({ tenantId: "tenant-konami-y", toolScopes: ["process:execute"] });

  await createGraphForAgent(b.agent.id, { plan: gamePlan("g17", [playtest("t")]) });
  const view = await graphForTask({ taskId: b.task.id, tenantId: "tenant-konami-y" });
  const otherNode = view.nodes.find(n => n.key === "t");

  const registry = new ToolAdapterRegistry();
  registry.register("shell", { execute: async () => ({ ok: true }) });
  const broker = new ToolBroker({ registry });

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

// ── Real workspace ───────────────────────────────────────────────────────────

test("a Konami graph writes real files into the workspace", async () => {
  const { agent } = await makeGameTask();
  const root = await mkdtemp(path.join(os.tmpdir(), "razekit-konami-real-"));
  try {
    await createGraphForAgent(agent.id, {
      plan: gamePlan("g18", [
        { ...projectInit("init"), projectFile: "config_version=5\n" },
        { id: "readme", kind: GAME_STEP_KINDS.ASSET_WRITE, path: "game/README.md", content: "# Konami\n" }
      ])
    });

    const result = await drainGraph({
      agentInstanceId: agent.id,
      workspaceRoot: root,
      adapters: gameAdapters()
    });
    assert.equal(result.status, "completed");

    // Real files, not a simulation.
    const readme = await readFile(path.join(root, "game", "README.md"), "utf8");
    assert.match(readme, /# Konami/);
    const project = await readFile(path.join(root, "game", "project.godot"), "utf8");
    assert.match(project, /config_version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
