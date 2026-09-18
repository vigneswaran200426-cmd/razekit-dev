import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_ALLOWED = new Set(["node", "npm", "git"]);

export class LocalProcessRuntime {
  constructor({ workspaceRoot, allowedExecutables = DEFAULT_ALLOWED } = {}) {
    if (!workspaceRoot) throw new Error("workspaceRoot is required");
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.allowedExecutables = new Set(allowedExecutables);
    this.child = null;
    this.cancelled = false;
  }

  async execute(step) {
    if (this.cancelled) throw new Error("Runtime cancelled");
    if (step.kind !== "command") {
      throw new Error("LocalProcessRuntime only supports command steps");
    }

    const executable = String(step.executable || "");
    if (!this.allowedExecutables.has(executable)) {
      throw new Error("Executable is not allowed: " + executable);
    }

    const cwd = path.resolve(this.workspaceRoot, step.cwd || ".");
    const relative = path.relative(this.workspaceRoot, cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Execution cwd escapes workspace root");
    }

    const args = Array.isArray(step.args) ? step.args.map(String) : [];
    const env = {};
    for (const key of Array.isArray(step.envAllowlist) ? step.envAllowlist : []) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: { ...env, PATH: process.env.PATH || "" },
        shell: false,
        windowsHide: true
      });
      this.child = child;

      let stdout = "";
      let stderr = "";
      const maxOutput = Number(step.maxOutputBytes || 200000);

      child.stdout?.on("data", chunk => {
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout) > maxOutput) {
          child.kill("SIGKILL");
          reject(new Error("Command output limit exceeded"));
        }
      });

      child.stderr?.on("data", chunk => {
        stderr += chunk.toString();
        if (Buffer.byteLength(stderr) > maxOutput) {
          child.kill("SIGKILL");
          reject(new Error("Command output limit exceeded"));
        }
      });

      child.on("error", reject);
      child.on("close", (code, signal) => {
        this.child = null;
        if (this.cancelled) return reject(new Error("Runtime cancelled"));
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || ("process exited with code " + code);
          return reject(new Error(detail));
        }
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.child) this.child.kill("SIGTERM");
  }
}
