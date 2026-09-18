import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { GAME_ENGINES } from "./game-domain.js";

const SUPPORTED_ENGINES = new Set(Object.values(GAME_ENGINES));

function resolveWorkspace(root, relativePath = ".") {
  const workspaceRoot = path.resolve(root);
  const candidate = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Game engine workspace path escapes the workspace");
  }
  return candidate;
}

function normalizeArgs(args = []) {
  if (!Array.isArray(args)) throw new Error("Engine command arguments must be an array");
  return args.map(String);
}

export class ConfiguredGameEngineAdapter {
  constructor({
    engine,
    executable,
    actions = {},
    buildArgs = null,
    processRunner = null
  } = {}) {
    if (!SUPPORTED_ENGINES.has(engine)) {
      throw new Error("Unsupported game engine: " + engine);
    }
    if (!executable?.trim()) throw new Error("Game engine executable is required");
    this.engine = engine;
    this.executable = executable;
    this.actions = { ...actions };
    this.buildArgs = buildArgs;
    this.processRunner = processRunner || runProcess;
  }

  async execute(step) {
    this.assertEngine(step);
    const configured = this.actions[step.action];
    if (!Array.isArray(configured)) {
      throw new Error("No command configured for " + this.engine + " action: " + step.action);
    }

    return this.run({
      args: normalizeArgs([...configured, ...(step.args || [])]),
      cwd: step.cwd || ".",
      timeoutMs: step.timeoutMs
    });
  }

  async build(step) {
    this.assertEngine(step);
    if (!Array.isArray(this.buildArgs)) {
      throw new Error("No build command configured for " + this.engine);
    }

    const outputDir = step.outputDir || "build";
    await mkdir(resolveWorkspace(step.workspaceRoot, outputDir), { recursive: true });

    return this.run({
      args: normalizeArgs([...this.buildArgs, ...(step.args || [])]),
      cwd: step.cwd || ".",
      timeoutMs: step.timeoutMs
    });
  }

  assertEngine(step) {
    if ((step.engine || this.engine) !== this.engine) {
      throw new Error("Engine adapter mismatch: expected " + this.engine);
    }
  }

  async run({ args, cwd, timeoutMs }) {
    return this.processRunner({
      executable: this.executable,
      args,
      cwd: resolveWorkspace(this.workspaceRoot || process.cwd(), cwd),
      timeoutMs
    });
  }

  attachWorkspace(workspaceRoot) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    return this;
  }
}

export function createConfiguredGameEngineAdapters({
  unity = null,
  unreal = null,
  godot = null
} = {}) {
  const configs = [
    [GAME_ENGINES.UNITY, unity],
    [GAME_ENGINES.UNREAL, unreal],
    [GAME_ENGINES.GODOT, godot]
  ];

  const adapters = new Map();
  for (const [engine, config] of configs) {
    if (!config) continue;
    adapters.set(engine, new ConfiguredGameEngineAdapter({
      engine,
      ...config
    }));
  }
  return adapters;
}

async function runProcess({ executable, args, cwd, timeoutMs = 0 }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env }
    });

    let stdout = "";
    let stderr = "";
    let timer = null;

    const finish = (error, result) => {
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error("Game engine process timed out"));
      }, timeoutMs);
    }

    child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || stdout.trim() || "Game engine process failed"));
        return;
      }
      finish(null, { code, signal, stdout, stderr });
    });
  });
}
