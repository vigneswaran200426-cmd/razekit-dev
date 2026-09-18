import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_ALLOWED = new Set(["node", "npm", "git"]);

// Windows ships `npm` as `npm.cmd` and `node` as `node.exe`. The allowlist is a
// list of *programs*, not of filenames, so the extension is stripped before the
// check — otherwise the same plan that runs on the Linux worker is rejected on a
// Windows one. Only these three extensions are stripped, so an entry like
// `evil.sh` can never be laundered into an allowed name.
const WINDOWS_EXECUTABLE_SUFFIX = /\.(exe|cmd|bat)$/i;

function canonicalExecutable(executable) {
  return process.platform === "win32"
    ? executable.replace(WINDOWS_EXECUTABLE_SUFFIX, "").toLowerCase()
    : executable;
}

// Node refuses to spawn a .cmd/.bat without a shell (CVE-2024-27980), and this
// runtime never opens a shell. npm on Windows *is* a .cmd, so it is launched
// through the JS entrypoint that sits beside it instead: same program, no shell,
// no argument re-parsing.
const WINDOWS_CMD_SHIMS = {
  npm: path.join("node_modules", "npm", "bin", "npm-cli.js"),
  npx: path.join("node_modules", "npm", "bin", "npx-cli.js")
};

function findOnPath(name) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Returns the [command, leadingArgs] actually handed to spawn(). Everywhere but
// Windows this is the program name unchanged.
function resolveLaunch(canonical) {
  if (process.platform !== "win32") return [canonical, []];

  const resolved = findOnPath(canonical);
  if (!resolved) return [canonical, []];
  if (/\.exe$/i.test(resolved)) return [resolved, []];

  const shim = WINDOWS_CMD_SHIMS[canonical];
  if (shim) {
    const jsEntrypoint = path.join(path.dirname(resolved), shim);
    if (existsSync(jsEntrypoint)) return [process.execPath, [jsEntrypoint]];
  }

  throw new Error(
    "Executable requires a shell on this platform and cannot be launched safely: " + canonical
  );
}

export class LocalProcessRuntime {
  constructor({ workspaceRoot, allowedExecutables = DEFAULT_ALLOWED } = {}) {
    if (!workspaceRoot) throw new Error("workspaceRoot is required");
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.allowedExecutables = new Set(
      [...allowedExecutables].map(canonicalExecutable)
    );
    this.child = null;
    this.cancelled = false;
  }

  async execute(step) {
    if (this.cancelled) throw new Error("Runtime cancelled");
    if (step.kind !== "command") {
      throw new Error("LocalProcessRuntime only supports command steps");
    }

    const executable = String(step.executable || "");
    const canonical = canonicalExecutable(executable);
    if (!this.allowedExecutables.has(canonical)) {
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

    const [command, leadingArgs] = resolveLaunch(canonical);

    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...leadingArgs, ...args], {
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
