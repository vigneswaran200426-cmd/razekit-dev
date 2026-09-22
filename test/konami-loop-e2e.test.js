import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Konami through the LIVE autonomous loop.
//
// konami-jev.test.js proves the pieces. This proves the thing that actually
// matters and that the pieces cannot: that driving the real loop end to end
// runs a Konami task through a JEV graph — not that the units compose in a
// test's own arrangement of them.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-konami-e2e-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-konami-e2e-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES, AGENT_STATUS } = await import("../src/domain.js");
const { GAME_ENGINES } = await import("../src/game-domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { configureModelRegistry, MODEL_MODE } = await import("../src/model-providers.js");
const { advanceAgent, LOOP_STAGE, configureGameAdapters } = await import("../src/autonomous-loop.js");
const { readBlackboard } = await import("../src/blackboard.js");
const {
  DeterministicGameEngineAdapter,
  DeterministicGamePlaytestAdapter,
  DeterministicGamePackagerAdapter
} = await import("../src/testing-game-adapters.js");

test.after(async () => {
  configureGameAdapters({});
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

function orchestratorWithTestAdapters() {
  const registry = new ModelAdapterRegistry();
  const previous = process.env.RAZEKIT_MODEL_MODE;
  process.env.RAZEKIT_MODEL_MODE = MODEL_MODE.TEST;
  const configuration = configureModelRegistry(registry);
  if (previous === undefined) delete process.env.RAZEKIT_MODEL_MODE;
  else process.env.RAZEKIT_MODEL_MODE = previous;
  assert.equal(configuration.mode, MODEL_MODE.TEST);
  return new ModelOrchestrator({ registry });
}

async function makeGameTask(title) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "konami-user",
    tenantId: "konami-tenant",
    taskType: "game",
    title,
    originalRequest: "Build " + title + " in godot",
    specification: "Build " + title + " in godot",
    requestedTools: ["filesystem", "engine", "game-playtest", "game-build"],
    estimatedBudget: 1,
    maxBudget: 5,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.KONAMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
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
      text: "The game project initialises, playtests and an artifact exists",
      status: "pending"
    });
  });
  return task;
}

async function runToCompletion(agentId, orchestrator, { maxTransitions = 25 } = {}) {
  const stages = [];
  for (let i = 0; i < maxTransitions; i += 1) {
    const result = await advanceAgent(agentId, { orchestrator });
    stages.push(result.stage);
    if ([LOOP_STAGE.COMPLETED, LOOP_STAGE.BLOCKED].includes(result.stage)) return { stages, result };
    if (result.stage === LOOP_STAGE.IDLE && !result.retryable) return { stages, result };
  }
  throw new Error("Loop did not settle. Stages: " + stages.join(" -> "));
}

test("a Konami game task runs through the live loop on a JEV graph", async () => {
  // The engine toolchain this deployment does not have. Registering
  // deterministic adapters is what makes the build and playtest steps runnable
  // at all; without them they fail exactly as they do in production today.
  configureGameAdapters({
    engineAdapters: new Map([
      [GAME_ENGINES.GODOT, new DeterministicGameEngineAdapter()],
      [GAME_ENGINES.UNITY, new DeterministicGameEngineAdapter()],
      [GAME_ENGINES.UNREAL, new DeterministicGameEngineAdapter()]
    ]),
    playtestAdapter: new DeterministicGamePlaytestAdapter(),
    packagerAdapter: new DeterministicGamePackagerAdapter()
  });

  const orchestrator = orchestratorWithTestAdapters();
  const task = await makeGameTask("Survival prototype");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  assert.equal(agent.agentType, AGENT_TYPES.KONAMI);

  const { stages, result } = await runToCompletion(agent.id, orchestrator);

  assert.equal(
    result.stage, LOOP_STAGE.COMPLETED,
    "expected the game task to complete; stages: " + stages.join(" -> ")
  );

  // Every stage of the documented machine actually ran.
  assert.ok(stages.includes(LOOP_STAGE.PLAN), "Astra never planned");
  assert.ok(stages.includes(LOOP_STAGE.IMPLEMENT), "Fable never implemented");
  assert.ok(stages.includes(LOOP_STAGE.EXECUTE), "the game plan was never executed");
  assert.ok(stages.includes(LOOP_STAGE.REVIEW), "Astra never reviewed");

  const db = await loadDb();
  const finalTask = db.tasks.find(x => x.id === task.id);
  const finalAgent = db.agentInstances.find(x => x.id === agent.id);
  assert.equal(finalTask.status, TASK_STATUS.COMPLETED);
  assert.equal(finalAgent.status, AGENT_STATUS.COMPLETED);

  // Completion is verification-gated, not model-asserted.
  const verification = db.verificationRuns.filter(x => x.agentInstanceId === agent.id).pop();
  assert.equal(verification.status, "passed");
  assert.ok(db.acceptanceCriteria.filter(x => x.taskId === task.id).every(x => x.status === "passed"));

  // ── It actually went through JEV ───────────────────────────────────────────
  //
  // Everything above would still pass if the loop had quietly used the old flat
  // game executor, so this has to be asserted rather than inferred.
  const runs = db.executionRuns.filter(x => x.agentInstanceId === agent.id);
  assert.ok(runs.length > 0, "an execution run should exist");
  assert.ok(
    runs.every(run => run.kind === "jev_game_graph"),
    "every run should be a game graph, got: " + runs.map(r => r.kind).join(", ")
  );
  assert.ok(
    !runs.some(run => run.kind === "game"),
    "the flat game executor must not have run"
  );

  const graphs = db.taskGraphs.filter(x => x.taskId === task.id);
  assert.equal(graphs.length, 1, "the task built exactly one graph");
  assert.equal(graphs[0].status, "succeeded");

  const nodes = db.graphNodes.filter(x => x.graphId === graphs[0].id);
  assert.ok(nodes.length > 1, "the game plan became more than one node");
  assert.ok(nodes.every(n => n.status === "succeeded"), "every node succeeded");
  // A succeeded node KEEPS its lease id — that is the fence a late duplicate
  // report is compared against. What must be released is the lease itself.
  assert.ok(nodes.every(n => n.leaseExpiresAt === null), "no node still holds an active lease");

  // Real dependency edges — a graph whose nodes all had none would be a list.
  assert.ok(
    nodes.some(n => (n.dependsOn || []).length > 0),
    "the game graph has real dependency edges"
  );

  // The engine travelled with the nodes, which is what a build node needs.
  assert.ok(
    nodes.some(n => n.payload?.engine),
    "the plan's engine reached the stored nodes"
  );

  // Game tool scopes, not App/Web ones.
  assert.ok(
    nodes.some(n => (n.toolScopes || []).some(s => s.startsWith("game-") || s.startsWith("engine:"))),
    "nodes carry game-specific tool scopes"
  );

  // Konami's blackboard state stayed under its own keys.
  const blackboard = await readBlackboard(agent.id);
  assert.ok(
    blackboard.some(x => x.key === "game.execution.lastResult"),
    "the game result was recorded under Konami's key"
  );
});
