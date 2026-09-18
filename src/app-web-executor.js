import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { id, loadDb, transact } from "./store.js";
import { ExecutionEngine } from "./execution-engine.js";
import { LocalProcessRuntime } from "./adapters/local-process-runtime.js";
import { writeCheckpoint } from "./reliability.js";
import { getAgent } from "./agent-manager.js";
import { readBlackboard, writeBlackboard } from "./blackboard.js";
import {
  APP_WEB_STEP_KINDS,
  assertAppWebPlan,
  normalizeModelExecutionPlan
} from "./app-web-domain.js";

function resolveWorkspacePath(workspaceRoot, relativePath) {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, relativePath || ".");
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Workspace path escapes the agent workspace");
  }
  return candidate;
}

export class AppWebRuntime {
  constructor({
    workspaceRoot,
    serviceAdapter = null,
    browserAdapter = null,
    deploymentAdapter = null,
    processRuntime = null
  } = {}) {
    if (!workspaceRoot) throw new Error("workspaceRoot is required");
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.serviceAdapter = serviceAdapter;
    this.browserAdapter = browserAdapter;
    this.deploymentAdapter = deploymentAdapter;
    this.processRuntime = processRuntime || new LocalProcessRuntime({
      workspaceRoot: this.workspaceRoot
    });
  }

  async execute(step, context = {}) {
    const cwd = resolveWorkspacePath(this.workspaceRoot, step.cwd || ".");

    switch (step.kind) {
      case APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE: {
        const filePath = resolveWorkspacePath(this.workspaceRoot, step.path);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, step.content, "utf8");
        return { operation: step.kind, path: path.relative(this.workspaceRoot, filePath) };
      }

      case APP_WEB_STEP_KINDS.WORKSPACE_MKDIR: {
        const directory = resolveWorkspacePath(this.workspaceRoot, step.path);
        await mkdir(directory, { recursive: true });
        return { operation: step.kind, path: path.relative(this.workspaceRoot, directory) };
      }

      case APP_WEB_STEP_KINDS.COMMAND:
        return this.processRuntime.execute({ ...step, cwd: path.relative(this.workspaceRoot, cwd) });

      case APP_WEB_STEP_KINDS.SERVICE:
        if (!this.serviceAdapter?.execute) {
          throw new Error("No App/Web service adapter is configured");
        }
        return this.serviceAdapter.execute({ ...step, workspaceRoot: this.workspaceRoot, context });

      case APP_WEB_STEP_KINDS.BROWSER_SMOKE:
        if (!this.browserAdapter?.execute) {
          throw new Error("No App/Web browser adapter is configured");
        }
        return this.browserAdapter.execute({ ...step, workspaceRoot: this.workspaceRoot, context });

      case APP_WEB_STEP_KINDS.DEPLOY:
        if (!this.deploymentAdapter?.execute) {
          throw new Error("No App/Web deployment adapter is configured");
        }
        return this.deploymentAdapter.execute({ ...step, workspaceRoot: this.workspaceRoot, context });

      case APP_WEB_STEP_KINDS.PACKAGE:
        return this.packageWorkspace(step);

      default:
        throw new Error("Unsupported App/Web step kind: " + step.kind);
    }
  }

  async packageWorkspace(step = {}) {
    const packageScript = step.packageScript || "npm";
    if (packageScript !== "npm") {
      throw new Error("Unsupported package script: " + packageScript);
    }

    const packageName = String(step.packageArgs?.[0] || "razekit-build");
    const packageDir = resolveWorkspacePath(this.workspaceRoot, step.outputDir || "artifacts");
    await mkdir(packageDir, { recursive: true });

    let packageMetadata;
    try {
      packageMetadata = JSON.parse(await readFile(
        resolveWorkspacePath(this.workspaceRoot, "package.json"),
        "utf8"
      ));
    } catch {
      throw new Error("App/Web package step requires package.json");
    }
    if (!packageMetadata.name?.trim()) {
      throw new Error("App/Web package step requires package.json name");
    }
    if (!packageMetadata.version?.trim()) {
      throw new Error("App/Web package step requires package.json version");
    }

    const result = await this.processRuntime.execute({
      id: step.id + "-package",
      kind: "command",
      executable: "npm",
      args: ["pack", "--pack-destination", path.relative(this.workspaceRoot, packageDir)],
      cwd: ".",
      timeoutMs: step.timeoutMs || 120000
    });

    const files = [];
    for (const name of String(result.stdout || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
      files.push(name);
    }

    return {
      operation: APP_WEB_STEP_KINDS.PACKAGE,
      packageName,
      outputDir: path.relative(this.workspaceRoot, packageDir),
      files
    };
  }

  cancel() {
    this.processRuntime.cancel();
  }
}

export async function buildAppWebExecutionPlan(agentInstanceId) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  if (agent.agentType !== "niomi") throw new Error("App/Web execution is only available to Niomi");

  const db = await loadDb();
  const task = db.tasks.find(x => x.id === agent.taskId);
  if (!task) throw new Error("Task not found");

  const blackboard = await readBlackboard(agentInstanceId);
  const modelPlanEntry = blackboard.find(x => x.key === "execution.plan");
  const modelPlan = normalizeModelExecutionPlan(
    modelPlanEntry ? modelPlanEntry.value : null
  );

  if (modelPlan) {
    return {
      ...modelPlan,
      agentInstanceId,
      taskId: task.id,
      source: "model"
    };
  }

  return {
    id: id("appwebplan"),
    version: 1,
    agentInstanceId,
    taskId: task.id,
    source: "baseline",
    steps: [
      {
        id: "repo-init",
        kind: APP_WEB_STEP_KINDS.COMMAND,
        phase: "repository",
        executable: "git",
        args: ["init"],
        retries: 1,
        timeoutMs: 30000
      },
      {
        id: "workspace-package-check",
        kind: APP_WEB_STEP_KINDS.COMMAND,
        phase: "repository",
        executable: "node",
        args: ["-e", "process.exit(require('fs').existsSync('package.json') ? 0 : 0)"],
        retries: 0,
        timeoutMs: 30000
      },
      {
        id: "run-tests",
        kind: APP_WEB_STEP_KINDS.COMMAND,
        phase: "test",
        executable: "npm",
        args: ["test"],
        retries: 1,
        timeoutMs: 120000
      },
      {
        id: "run-build",
        kind: APP_WEB_STEP_KINDS.COMMAND,
        phase: "build",
        executable: "npm",
        args: ["run", "build"],
        retries: 1,
        timeoutMs: 120000
      },
      {
        id: "package",
        kind: APP_WEB_STEP_KINDS.PACKAGE,
        phase: "package",
        retries: 1,
        timeoutMs: 120000,
        packageName: task.title
      }
    ]
  };
}

export async function executeAppWebTask({
  agentInstanceId,
  workspaceRoot,
  plan = null,
  serviceAdapter = null,
  browserAdapter = null,
  deploymentAdapter = null
}) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  if (agent.agentType !== "niomi") throw new Error("App/Web execution is only available to Niomi");
  if (!["running", "waiting_user"].includes(agent.status)) {
    throw new Error("Niomi agent must be running before App/Web execution");
  }

  const executionPlan = plan ? normalizeModelExecutionPlan(plan) : await buildAppWebExecutionPlan(agentInstanceId);
  assertAppWebPlan(executionPlan);

  const runId = id("appweb");
  await transact(db => {
    db.executionRuns.push({
      id: runId,
      taskId: agent.taskId,
      agentInstanceId,
      kind: "app_web",
      planId: executionPlan.id,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null
    });
  });

  const runtime = new AppWebRuntime({
    workspaceRoot,
    serviceAdapter,
    browserAdapter,
    deploymentAdapter
  });

  const engine = new ExecutionEngine({
    runtime,
    checkpoint: async currentPlan => {
      await writeCheckpoint(
        {
          agentInstanceId,
          taskId: agent.taskId,
          kind: "app_web_execution",
          scopeId: runId
        },
        currentPlan,
        { runId, planId: executionPlan.id }
      );
    },
    onStepEvent: async event => {
      await writeBlackboard(
        agentInstanceId,
        "execution.lastEvent",
        event,
        "app-web-runtime"
      );
    }
  });

  try {
    const result = await engine.run(executionPlan, {
      agentInstanceId,
      taskId: agent.taskId,
      runId
    });

    await transact(db => {
      const run = db.executionRuns.find(x => x.id === runId);
      run.status = result.status;
      run.completedAt = new Date().toISOString();
      run.result = result;
      run.error = result.error || null;
    });
    await writeBlackboard(
      agentInstanceId,
      "execution.lastResult",
      {
        runId,
        status: result.status,
        planId: executionPlan.id,
        completedAt: new Date().toISOString(),
        error: result.error || null
      },
      "app-web-runtime"
    );

    return { runId, ...result };
  } catch (error) {
    await transact(db => {
      const run = db.executionRuns.find(x => x.id === runId);
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.error = error.message || "App/Web execution failed";
    });
    throw error;
  }
}

export async function listAppWebRuns(agentInstanceId) {
  const db = await loadDb();
  return db.executionRuns.filter(x => x.agentInstanceId === agentInstanceId);
}
