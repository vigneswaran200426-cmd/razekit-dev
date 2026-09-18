import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-game-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-game-root-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const {
  buildGameExecutionPlan,
  executeGameTask,
  GameRuntime
} = await import("../src/game-executor.js");
const { GAME_ENGINES, GAME_STEP_KINDS } = await import("../src/game-domain.js");
const {
  DeterministicGameEngineAdapter,
  DeterministicGamePlaytestAdapter,
  DeterministicGamePackagerAdapter
} = await import("../src/testing-game-adapters.js");

async function makeGameAgent() {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "game-test-user",
    taskType: "game",
    title: "Konami game execution",
    originalRequest: "Build a small game in Godot",
    specification: "Build a small game with an automated playtest and build",
    requestedTools: ["filesystem", "shell", "git", "engine", "assets", "game-playtest", "game-build"],
    estimatedBudget: 25,
    maxBudget: 60,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "konami",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes: [
        "workspace:read",
        "workspace:write",
        "process:execute",
        "git:read",
        "git:write",
        "engine:read",
        "engine:write",
        "engine:build",
        "assets:read",
        "assets:write",
        "playtest:run",
        "playtest:inspect",
        "game-build:build",
        "game-build:package"
      ],
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
      text: "Game execution succeeds",
      status: "pending"
    });
  });

  const agent = await spawnAgentForTask(task.id);
  return startAgent(agent.id);
}

test("Konami executes project initialization, asset pipeline, playtest, build and package", async () => {
  const agent = await makeGameAgent();
  const db = await loadDb();
  const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
  const calls = [];

  const engine = new DeterministicGameEngineAdapter({ calls });
  const playtest = new DeterministicGamePlaytestAdapter({ calls });
  const packager = new DeterministicGamePackagerAdapter({ calls });

  const plan = {
    id: "godot-game-plan",
    version: 1,
    engine: GAME_ENGINES.GODOT,
    steps: [
      {
        id: "init",
        kind: GAME_STEP_KINDS.PROJECT_INIT,
        phase: "repository",
        engine: GAME_ENGINES.GODOT,
        path: "game",
        projectFile: "[application]\nconfig/name=\"Konami Test Game\"\n",
        retries: 0
      },
      {
        id: "asset",
        kind: GAME_STEP_KINDS.ASSET_WRITE,
        phase: "assets",
        path: "game/assets/player.txt",
        content: "player-asset",
        retries: 0
      },
      {
        id: "engine",
        kind: GAME_STEP_KINDS.ENGINE_ACTION,
        phase: "implementation",
        engine: GAME_ENGINES.GODOT,
        action: "generate_main_scene",
        retries: 1
      },
      {
        id: "playtest",
        kind: GAME_STEP_KINDS.PLAYTEST,
        phase: "test",
        engine: GAME_ENGINES.GODOT,
        checks: ["project opens", "main scene loads"],
        retries: 1
      },
      {
        id: "build",
        kind: GAME_STEP_KINDS.BUILD,
        phase: "build",
        engine: GAME_ENGINES.GODOT,
        target: "windows",
        retries: 1
      },
      {
        id: "package",
        kind: GAME_STEP_KINDS.PACKAGE,
        phase: "package",
        engine: GAME_ENGINES.GODOT,
        artifactName: "Konami Test Game"
      }
    ]
  };

  const result = await executeGameTask({
    agentInstanceId: agent.id,
    workspaceRoot: workspace.path,
    plan,
    engineAdapters: new Map([[GAME_ENGINES.GODOT, engine]]),
    playtestAdapter: playtest,
    packagerAdapter: packager
  });

  assert.equal(result.status, "completed");
  assert.equal(result.plan.steps.at(-1).state, "passed");
  assert.deepEqual(calls.map(x => x.type), ["engine", "playtest", "build", "package"]);

  const after = await loadDb();
  const run = after.executionRuns.find(x => x.id === result.runId);
  assert.equal(run.kind, "game");
  assert.equal(run.status, "completed");
  assert.equal(run.engine, GAME_ENGINES.GODOT);
  assert.equal(run.artifacts[0].artifactId, "game-artifact-1");

  const checkpoint = after.stateCheckpoints.find(x => x.scopeId === result.runId);
  assert.ok(checkpoint);
  assert.equal(checkpoint.kind, "game_execution");

  const blackboard = after.agentBlackboards.filter(x =>
    x.agentInstanceId === agent.id && x.key === "game.execution.lastResult"
  );
  assert.equal(blackboard.length, 1);
});

test("Konami selects an engine from the task and can read a model-generated game plan", async () => {
  const agent = await makeGameAgent();
  const baseline = await buildGameExecutionPlan(agent.id);
  assert.equal(baseline.source, "baseline");
  assert.equal(baseline.engine, GAME_ENGINES.GODOT);

  await transact(db => {
    db.agentBlackboards.push({
      id: id("bb"),
      agentInstanceId: agent.id,
      key: "game.execution.plan",
      value: JSON.stringify({
        id: "unity-model-plan",
        version: 2,
        engine: GAME_ENGINES.UNITY,
        steps: [{
          id: "unity-build",
          kind: GAME_STEP_KINDS.BUILD,
          engine: GAME_ENGINES.UNITY,
          target: "windows"
        }]
      }),
      version: 1,
      source: "astra",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });

  const generated = await buildGameExecutionPlan(agent.id);
  assert.equal(generated.source, "model");
  assert.equal(generated.id, "unity-model-plan");
  assert.equal(generated.engine, GAME_ENGINES.UNITY);
});

test("Game runtime blocks workspace escape and requires explicit engine adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-game-runtime-root-"));
  const runtime = new GameRuntime({ workspaceRoot: root });

  await assert.rejects(
    () => runtime.execute({
      id: "escape",
      kind: GAME_STEP_KINDS.ASSET_WRITE,
      path: "../outside.txt",
      content: "blocked"
    }),
    /escapes the agent workspace/
  );

  await assert.rejects(
    () => runtime.execute({
      id: "engine",
      kind: GAME_STEP_KINDS.ENGINE_ACTION,
      engine: GAME_ENGINES.UNITY,
      action: "open_project"
    }),
    /No game engine adapter is configured/
  );

  await rm(root, { recursive: true, force: true });
});

test("Konami supports Unity and Unreal adapter contracts without coupling engine logic to the executor", async () => {
  const calls = [];
  const unity = new DeterministicGameEngineAdapter({ calls });
  const unreal = new DeterministicGameEngineAdapter({ calls });
  const root = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-game-adapters-"));
  const runtime = new GameRuntime({
    workspaceRoot: root,
    engineAdapters: new Map([
      [GAME_ENGINES.UNITY, unity],
      [GAME_ENGINES.UNREAL, unreal]
    ])
  });

  const unityResult = await runtime.execute({
    id: "unity",
    kind: GAME_STEP_KINDS.ENGINE_ACTION,
    engine: GAME_ENGINES.UNITY,
    action: "generate_project"
  });
  const unrealResult = await runtime.execute({
    id: "unreal",
    kind: GAME_STEP_KINDS.BUILD,
    engine: GAME_ENGINES.UNREAL,
    target: "windows"
  });

  assert.equal(unityResult.engine, GAME_ENGINES.UNITY);
  assert.equal(unrealResult.engine, GAME_ENGINES.UNREAL);
  assert.deepEqual(calls.map(x => x.engine), [GAME_ENGINES.UNITY, GAME_ENGINES.UNREAL]);

  await rm(root, { recursive: true, force: true });
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
