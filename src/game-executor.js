import { mkdir, readFile, stat, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { id, loadDb, transact } from "./store.js";
import { ExecutionEngine } from "./execution-engine.js";
import { LocalProcessRuntime } from "./adapters/local-process-runtime.js";
import { writeCheckpoint } from "./reliability.js";
import { getAgent } from "./agent-manager.js";
import { readBlackboard, writeBlackboard } from "./blackboard.js";
import {
  GAME_ENGINES,
  GAME_STEP_KINDS,
  assertGamePlan,
  normalizeGamePlan
} from "./game-domain.js";

function resolveWorkspacePath(workspaceRoot, relativePath) {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, relativePath || ".");
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Workspace path escapes the agent workspace");
  }
  return candidate;
}

function safeString(value, fallback = "") {
  return String(value == null ? fallback : value);
}

export class GameRuntime {
  constructor({
    workspaceRoot,
    engineAdapters = new Map(),
    playtestAdapter = null,
    packagerAdapter = null,
    processRuntime = null
  } = {}) {
    if (!workspaceRoot) throw new Error("workspaceRoot is required");
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.engineAdapters = engineAdapters instanceof Map
      ? engineAdapters
      : new Map(Object.entries(engineAdapters || {}));
    this.playtestAdapter = playtestAdapter;
    this.packagerAdapter = packagerAdapter;
    this.processRuntime = processRuntime || new LocalProcessRuntime({
      workspaceRoot: this.workspaceRoot
    });
  }

  async execute(step, context = {}) {
    switch (step.kind) {
      case GAME_STEP_KINDS.PROJECT_INIT:
        return this.projectInit(step);

      case GAME_STEP_KINDS.ASSET_WRITE:
        return this.writeAsset(step);

      case GAME_STEP_KINDS.ASSET_COPY:
        return this.copyAsset(step);

      case GAME_STEP_KINDS.COMMAND: {
        const cwd = resolveWorkspacePath(this.workspaceRoot, step.cwd || ".");
        return this.processRuntime.execute({
          ...step,
          cwd: path.relative(this.workspaceRoot, cwd)
        });
      }

      case GAME_STEP_KINDS.ENGINE_ACTION: {
        const adapter = this.engineAdapters.get(step.engine || context.engine);
        if (!adapter?.execute) {
          throw new Error("No game engine adapter is configured for " + (step.engine || context.engine));
        }
        return adapter.execute({
          ...step,
          workspaceRoot: this.workspaceRoot,
          context
        });
      }

      case GAME_STEP_KINDS.PLAYTEST:
        if (!this.playtestAdapter?.execute) {
          throw new Error("No game playtest adapter is configured");
        }
        return this.playtestAdapter.execute({
          ...step,
          workspaceRoot: this.workspaceRoot,
          context
        });

      case GAME_STEP_KINDS.BUILD: {
        const adapter = this.engineAdapters.get(step.engine || context.engine);
        if (!adapter?.build) {
          throw new Error("No game engine build adapter is configured for " + (step.engine || context.engine));
        }
        return adapter.build({
          ...step,
          workspaceRoot: this.workspaceRoot,
          context
        });
      }

      case GAME_STEP_KINDS.PACKAGE:
        if (this.packagerAdapter?.package) {
          return this.packagerAdapter.package({
            ...step,
            workspaceRoot: this.workspaceRoot,
            context
          });
        }
        return packageGameWorkspace(this.workspaceRoot, step);

      default:
        throw new Error("Unsupported game step kind: " + step.kind);
    }
  }

  async projectInit(step) {
    const projectPath = resolveWorkspacePath(this.workspaceRoot, step.path || ".");
    await mkdir(projectPath, { recursive: true });

    if (step.engine === GAME_ENGINES.GODOT && step.projectFile) {
      const projectFile = resolveWorkspacePath(this.workspaceRoot, path.join(step.path || ".", "project.godot"));
      await writeFile(projectFile, step.projectFile, "utf8");
    }

    if (step.engine === GAME_ENGINES.UNITY && step.projectSettings) {
      const settingsPath = resolveWorkspacePath(
        this.workspaceRoot,
        path.join(step.path || ".", "ProjectSettings", "project-version.txt")
      );
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, safeString(step.projectSettings), "utf8");
    }

    if (step.engine === GAME_ENGINES.UNREAL && step.projectFile) {
      const projectFile = resolveWorkspacePath(
        this.workspaceRoot,
        path.join(step.path || ".", safeString(step.projectName, "RazeKitGame") + ".uproject")
      );
      await writeFile(projectFile, step.projectFile, "utf8");
    }

    return {
      operation: GAME_STEP_KINDS.PROJECT_INIT,
      engine: step.engine,
      path: step.path || "."
    };
  }

  async writeAsset(step) {
    const target = resolveWorkspacePath(this.workspaceRoot, step.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, step.content);
    return {
      operation: GAME_STEP_KINDS.ASSET_WRITE,
      path: path.relative(this.workspaceRoot, target)
    };
  }

  async copyAsset(step) {
    const source = resolveWorkspacePath(this.workspaceRoot, step.source);
    const destination = resolveWorkspacePath(this.workspaceRoot, step.destination);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("Asset copy source must be a file");
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
    return {
      operation: GAME_STEP_KINDS.ASSET_COPY,
      source: path.relative(this.workspaceRoot, source),
      destination: path.relative(this.workspaceRoot, destination)
    };
  }

  cancel() {
    this.processRuntime.cancel();
  }
}

async function packageGameWorkspace(workspaceRoot, step = {}) {
  const outputDir = resolveWorkspacePath(workspaceRoot, step.outputDir || "artifacts");
  await mkdir(outputDir, { recursive: true });

  const manifest = {
    engine: step.engine || null,
    artifactName: safeString(step.artifactName, "razekit-game"),
    packagedAt: new Date().toISOString(),
    source: "."
  };

  const manifestFile = path.join(outputDir, "artifact-manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));

  return {
    operation: GAME_STEP_KINDS.PACKAGE,
    outputDir: path.relative(workspaceRoot, outputDir),
    manifest: path.relative(workspaceRoot, manifestFile)
  };
}

export async function buildGameExecutionPlan(agentInstanceId) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  if (agent.agentType !== "konami") throw new Error("Game execution is only available to Konami");

  const db = await loadDb();
  const task = db.tasks.find(x => x.id === agent.taskId);
  if (!task) throw new Error("Task not found");

  const blackboard = await readBlackboard(agentInstanceId);
  const modelPlanEntry = blackboard.find(x => x.key === "game.execution.plan");
  const modelPlan = normalizeGamePlan(modelPlanEntry?.value);

  if (modelPlan) {
    return {
      ...modelPlan,
      agentInstanceId,
      taskId: task.id,
      source: "model"
    };
  }

  const text = ((task.title || "") + " " + (task.originalRequest || "") + " " + (task.specification || "")).toLowerCase();
  const engine = text.includes("unreal") ? GAME_ENGINES.UNREAL
    : text.includes("godot") ? GAME_ENGINES.GODOT
    : GAME_ENGINES.UNITY;

  return {
    id: id("gameplan"),
    version: 1,
    engine,
    agentInstanceId,
    taskId: task.id,
    source: "baseline",
    steps: [
      {
        id: "project-init",
        kind: GAME_STEP_KINDS.PROJECT_INIT,
        phase: "repository",
        engine,
        path: "game",
        retries: 1,
        timeoutMs: 30000,
        projectName: task.title
      },
      {
        id: "asset-pipeline-ready",
        kind: GAME_STEP_KINDS.ASSET_WRITE,
        phase: "assets",
        path: "game/README.md",
        content: "# Generated by Konami\n",
        retries: 0
      },
      {
        id: "playtest",
        kind: GAME_STEP_KINDS.PLAYTEST,
        phase: "test",
        engine,
        checks: ["project opens", "main scene loads"],
        retries: 1,
        timeoutMs: 120000
      },
      {
        id: "build",
        kind: GAME_STEP_KINDS.BUILD,
        phase: "build",
        engine,
        target: "development",
        retries: 1,
        timeoutMs: 300000
      },
      {
        id: "package",
        kind: GAME_STEP_KINDS.PACKAGE,
        phase: "package",
        engine,
        artifactName: task.title,
        retries: 1,
        timeoutMs: 120000
      }
    ]
  };
}

export async function executeGameTask({
  agentInstanceId,
  workspaceRoot,
  plan = null,
  engineAdapters = new Map(),
  playtestAdapter = null,
  packagerAdapter = null
}) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  if (agent.agentType !== "konami") throw new Error("Game execution is only available to Konami");
  if (!["running", "waiting_user"].includes(agent.status)) {
    throw new Error("Konami agent must be running before game execution");
  }

  const executionPlan = plan ? normalizeGamePlan(plan) : await buildGameExecutionPlan(agentInstanceId);
  assertGamePlan(executionPlan);

  const runId = id("gameexec");
  await transact(db => {
    db.executionRuns.push({
      id: runId,
      taskId: agent.taskId,
      agentInstanceId,
      kind: "game",
      planId: executionPlan.id,
      engine: executionPlan.engine,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null,
      artifacts: []
    });
  });

  const runtime = new GameRuntime({
    workspaceRoot,
    engineAdapters,
    playtestAdapter,
    packagerAdapter
  });

  const engine = new ExecutionEngine({
    runtime,
    checkpoint: async currentPlan => {
      await writeCheckpoint(
        {
          agentInstanceId,
          taskId: agent.taskId,
          kind: "game_execution",
          scopeId: runId
        },
        currentPlan,
        { runId, planId: executionPlan.id, engine: executionPlan.engine }
      );
    },
    onStepEvent: async event => {
      await writeBlackboard(
        agentInstanceId,
        "game.execution.lastEvent",
        event,
        "game-runtime"
      );
    }
  });

  try {
    const result = await engine.run(executionPlan, {
      agentInstanceId,
      taskId: agent.taskId,
      runId,
      engine: executionPlan.engine
    });

    await transact(db => {
      const run = db.executionRuns.find(x => x.id === runId);
      run.status = result.status;
      run.completedAt = new Date().toISOString();
      run.result = result;
      run.error = result.error || null;
      const packageSteps = result.plan.steps.filter(step => step.kind === GAME_STEP_KINDS.PACKAGE && step.result);
      run.artifacts = packageSteps.map(step => step.result);
    });

    await writeBlackboard(
      agentInstanceId,
      "game.execution.lastResult",
      {
        runId,
        status: result.status,
        engine: executionPlan.engine,
        planId: executionPlan.id,
        artifacts: result.plan.steps
          .filter(step => step.kind === GAME_STEP_KINDS.PACKAGE && step.result)
          .map(step => step.result)
      },
      "game-runtime"
    );

    return { runId, ...result };
  } catch (error) {
    await transact(db => {
      const run = db.executionRuns.find(x => x.id === runId);
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.error = error.message || "Game execution failed";
    });
    throw error;
  }
}

export async function listGameRuns(agentInstanceId) {
  const db = await loadDb();
  return db.executionRuns.filter(x => x.agentInstanceId === agentInstanceId && x.kind === "game");
}
