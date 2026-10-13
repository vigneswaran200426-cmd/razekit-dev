import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";

// Where System A runs code a model wrote. The bubblewrap half runs for real
// wherever bwrap can create namespaces, and is skipped (announced) elsewhere.

const { runCommand, sandboxedCommand, assertSandboxForModelCode } = await import("../src/ops-builder.js");

const dir = await mkdtemp(path.join(os.tmpdir(), "razekit-sandbox-"));
test.after(() => rm(dir, { recursive: true, force: true }));

const git = (args, cwd) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function bwrapUsable() {
  const probe = spawnSync("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"], { encoding: "utf8" });
  return probe.status === 0;
}
const BWRAP = bwrapUsable();

test("model-written code is refused in process mode unless explicitly allowed", () => {
  assert.throws(() => assertSandboxForModelCode({ sandbox: "process" }), /Refusing to run model-written code without a sandbox/);
  assert.doesNotThrow(() => assertSandboxForModelCode({ sandbox: "process", allowUnsandboxed: true }));
  assert.doesNotThrow(() => assertSandboxForModelCode({ sandbox: "bwrap" }));
  assert.doesNotThrow(() => assertSandboxForModelCode({ sandbox: "docker" }));
  assert.throws(() => sandboxedCommand("chroot", dir, "npm", ["test"]), /Unknown builder sandbox/);
});

test("the container and bubblewrap commands cut the network and keep .git read-only", async () => {
  const repo = path.join(dir, "shape");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  const [dockerCmd, dockerArgs] = sandboxedCommand("docker", repo, "npm", ["test"]);
  assert.equal(dockerCmd, "docker");
  assert.ok(dockerArgs.includes("--network") && dockerArgs[dockerArgs.indexOf("--network") + 1] === "none");
  assert.ok(dockerArgs.includes(path.join(repo, ".git") + ":/work/.git:ro"));
  const [bwrapCmd, bwrapArgs] = sandboxedCommand("bwrap", repo, "npm", ["test"]);
  assert.equal(bwrapCmd, "bwrap");
  for (const flag of ["--unshare-all", "--clearenv", "--die-with-parent", "--new-session"]) assert.ok(bwrapArgs.includes(flag), flag);
  const ro = bwrapArgs.indexOf(path.join(repo, ".git"));
  assert.equal(bwrapArgs[ro - 1], "--ro-bind");
  assert.ok(!bwrapArgs.join(" ").includes("/etc/razekit"), "no secret directory is mounted");
});

test("git hooks planted in the working tree never run", async () => {
  const repo = path.join(dir, "hooks");
  await mkdir(repo, { recursive: true });
  git(["init", "-q"], repo);
  const marker = path.join(dir, "hook-ran");
  await writeFile(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch " + JSON.stringify(marker) + "\n");
  await chmod(path.join(repo, ".git", "hooks", "pre-commit"), 0o755);
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await runCommand("git", ["add", "a.txt"], { cwd: repo });
  const result = await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(marker), false, "the planted pre-commit hook ran");
});

test("inside bubblewrap: no secrets, no host processes, no network, no hook planting", { skip: BWRAP ? false : "bwrap cannot create namespaces here" }, async () => {
  const repo = path.join(dir, "escape");
  await mkdir(repo, { recursive: true });
  git(["init", "-q"], repo);
  // What a hostile test file would try.
  await writeFile(path.join(repo, "probe.mjs"), `
    import { readFileSync, readdirSync, writeFileSync } from "node:fs";
    const out = {};
    out.envHasSecret = JSON.stringify(process.env).includes("sandbox-canary");
    out.procEnvironHasSecret = readdirSync("/proc").filter(p => /^\\d+$/.test(p)).some(p => { try { return readFileSync("/proc/" + p + "/environ", "utf8").includes("sandbox-canary"); } catch { return false; } });
    out.processes = readdirSync("/proc").filter(p => /^\\d+$/.test(p)).length;
    try { writeFileSync(".git/hooks/pre-push", "#!/bin/sh\\necho pwned\\n"); out.hookWritten = true; } catch (e) { out.hookWritten = false; out.hookError = e.code; }
    try { await fetch("https://example.com", { signal: AbortSignal.timeout(4000) }); out.network = true; } catch { out.network = false; }
    writeFileSync("result.json", JSON.stringify(out));
  `);
  process.env.RAZEKIT_DATABASE_URL = "postgres://sandbox-canary@db/x";
  process.env.RAZEKIT_BUILDER_GITHUB_TOKEN = "sandbox-canary-token";
  try {
    const [command, args] = sandboxedCommand("bwrap", repo, "node", ["probe.mjs"]);
    const run = await runCommand(command, args, { cwd: repo, timeoutMs: 30_000 });
    assert.equal(run.code, 0, run.stderr);
  } finally {
    delete process.env.RAZEKIT_DATABASE_URL;
    delete process.env.RAZEKIT_BUILDER_GITHUB_TOKEN;
  }
  const out = JSON.parse(await readFile(path.join(repo, "result.json"), "utf8"));
  assert.equal(out.envHasSecret, false, "secret visible in the sandbox environment");
  assert.equal(out.procEnvironHasSecret, false, "secret readable through /proc");
  assert.ok(out.processes <= 3, "host processes visible: " + out.processes);
  assert.equal(out.hookWritten, false, "a git hook could be planted");
  assert.equal(out.network, false, "the sandbox reached the network");
  assert.equal(existsSync(path.join(repo, ".git", "hooks", "pre-push")), false);
});
