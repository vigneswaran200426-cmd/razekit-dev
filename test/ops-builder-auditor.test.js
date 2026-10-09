import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-ops-ba-"));
const fixtureRepo = path.join(dataDir, "origin-repo");
Object.assign(process.env, {
  RAZEKIT_DATA_DIR: dataDir,
  RAZEKIT_STORE: "json",
  RAZEKIT_OPS_ALLOW_JSON_STORE: "true",
  RAZEKIT_OPS_WORKSPACE_ROOT: path.join(dataDir, "ws"),
  RAZEKIT_OPS_LOG_DIR: path.join(dataDir, "logs"),
  RAZEKIT_BUILDER_REPO_URL: fixtureRepo,
  RAZEKIT_BUILDER_BASE_BRANCH: "main",
  RAZEKIT_BUILDER_INFERENCE_WAIT_MS: "4000",
  RAZEKIT_AUDITOR_REPAIRS: ""
});
delete process.env.RAZEKIT_BUILDER_GITHUB_TOKEN;

const { createSupervisor } = await import("../src/ops-supervisor.js");
const { parseNodeTestSummary } = await import("../src/ops-builder.js");
const state = await import("../src/ops-state.js");
const { transact, loadDb } = await import("../src/store.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, { timeoutMs = 60_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + label);
    await sleep(50);
  }
}
const git = (args, cwd = fixtureRepo) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
};

// A small repository with the same layout System A works on, so its real
// tools — git clone, npm test, scoped edits — run for real.
test.before(async () => {
  await mkdir(path.join(fixtureRepo, "src"), { recursive: true });
  await mkdir(path.join(fixtureRepo, "test"), { recursive: true });
  await writeFile(path.join(fixtureRepo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }));
  await writeFile(path.join(fixtureRepo, "src", "dashboard-page.js"), "export const title = 'Control';\n");
  await writeFile(path.join(fixtureRepo, "test", "dashboard-page.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/dashboard-page.js';\ntest('title', () => assert.match(title, /Control/));\n");
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
});
test.after(() => rm(dataDir, { recursive: true, force: true }));

async function runOne(supervisor, taskId, done = ["completed", "failed", "dead_letter", "waiting_inference", "cancelled"]) {
  // Keep ticking: System B's own schedule may enqueue an audit ahead of ours.
  return until(async () => {
    if (!supervisor.current) await supervisor.tick();
    const task = await state.getTask(taskId);
    return done.includes(task.status) ? task : null;
  }, { label: "task " + taskId });
}

/** Answers queued inference like a model would, from a script — a test double for the gateway. */
function scriptedGateway(script) {
  let stop = false;
  const seen = [];
  const loop = (async () => {
    while (!stop) {
      const db = await loadDb();
      for (const request of db.opsInferenceRequests.filter(item => item.status === "queued")) {
        const content = script(request);
        if (content == null) continue;
        seen.push(request.purpose);
        await state.finishInference(request.id, { ok: true, model: request.slot === "coding" ? "qwen3-coder:30b" : "gpt-oss:20b", result: { content: JSON.stringify(content), toolCalls: [] }, usage: { promptTokens: 10, completionTokens: 5 } });
      }
      await sleep(50);
    }
  })();
  return { seen, stop: async () => { stop = true; await loop; } };
}

test("node --test summaries are parsed from real output", () => {
  const summary = parseNodeTestSummary("✔ a (1ms)\n✖ b (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\n✖ failing tests:\n✖ b (2ms)\n");
  assert.deepEqual({ total: summary.total, pass: summary.pass, fail: summary.fail, skipped: summary.skipped }, { total: 2, pass: 1, fail: 1, skipped: 0 });
  assert.deepEqual(summary.failing, ["b"]);
});

test("System A inspects a repository with real git and a real test run", async () => {
  const builder = await createSupervisor("builder", { pollMs: 20 });
  await builder.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "repo.inspect", title: "Inspect fixture" });
  const done = await runOne(builder, task.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.result.tests.passed, true);
  assert.equal(done.result.tests.pass, 1);
  assert.equal(done.result.head, git(["rev-parse", "HEAD"]));
  assert.ok((await state.latestCheckpoint(task.id)).step === "tests");
  await builder.shutdown();
});

test("without a model answer, a code change parks and waits — it never completes on its own", async () => {
  const builder = await createSupervisor("builder", { pollMs: 20 });
  await builder.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "code.change", scopeArea: "dev-frontend", title: "Rename the title", goal: "Make the title say Control Center" });
  const parked = await runOne(builder, task.id);
  assert.equal(parked.status, "waiting_inference");
  assert.ok(parked.waitingFor.requestId);
  const request = await state.getInference(parked.waitingFor.requestId);
  assert.equal(request.requester, "builder");
  assert.equal(request.slot, "reasoning", "planning goes to the reasoning slot");
  await state.cancelTask(task.id, { by: "test" });
  await state.finishInference(request.id, { ok: false, model: null, error: "cleanup" });
  await builder.shutdown();
});

test("a code change: plan, scoped edit, real tests, review, commit — and no PR without the GitHub token", async () => {
  const gateway = scriptedGateway(request => {
    if (request.purpose === "builder:plan") return { steps: ["edit title"], files: ["src/dashboard-page.js", "src/auth.js"], tests: [], risks: [] };
    if (request.purpose === "builder:implement") return { summary: "Title says Control Center", edits: [{ path: "src/dashboard-page.js", content: "export const title = 'Control Center';\n" }] };
    if (request.purpose === "builder:review") return { verdict: "approve", issues: [] };
    return null;
  });
  const builder = await createSupervisor("builder", { pollMs: 20 });
  await builder.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "code.change", scopeArea: "dev-frontend", title: "Rename the title", goal: "Make the title say Control Center", maxAttempts: 1 });
  const done = await runOne(builder, task.id);
  await gateway.stop();
  assert.equal(done.status, "failed");
  assert.match(done.error, /RAZEKIT_BUILDER_GITHUB_TOKEN is not configured, so no branch was pushed and no draft PR opened/);
  const workspace = path.join(process.env.RAZEKIT_OPS_WORKSPACE_ROOT, "builder", "repo");
  assert.match(git(["log", "-1", "--format=%s"], workspace), /^builder: Title says Control Center/);
  assert.equal(git(["show", "HEAD:src/dashboard-page.js"], workspace), "export const title = 'Control Center';");
  assert.deepEqual(gateway.seen, ["builder:plan", "builder:implement", "builder:review"]);
  assert.equal(git(["rev-parse", "main"]), git(["rev-parse", "HEAD"]), "the origin's main branch is untouched");
  await builder.shutdown();
});

test("an edit outside the task's scope area is refused before anything is written", async () => {
  const gateway = scriptedGateway(request => {
    if (request.purpose === "builder:plan") return { steps: ["x"], files: ["src/dashboard-page.js"] };
    if (request.purpose === "builder:implement") return { summary: "sneaky", edits: [{ path: "src/auth.js", content: "export const bypass = true;\n" }] };
    return null;
  });
  const builder = await createSupervisor("builder", { pollMs: 20 });
  await builder.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "code.change", scopeArea: "dev-frontend", title: "Out of scope", goal: "x", maxAttempts: 1 });
  const done = await runOne(builder, task.id);
  await gateway.stop();
  assert.equal(done.status, "failed");
  assert.match(done.error, /Refused edit outside scope area dev-frontend: src\/auth\.js/);
  await builder.shutdown();
});

test("System B audits real state, files one engineering task for a repeated failure, and resolves cleared findings", async () => {
  const health = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, store: "postgres", models: { mode: "real" } })); });
  await new Promise(resolve => health.listen(0, "127.0.0.1", resolve));
  process.env.RAZEKIT_DEV_BASE_URL = "http://127.0.0.1:" + health.address().port;
  await state.writeHeartbeat("builder", { processId: "old", status: "running" }, Date.now() - 60 * 60_000);
  await transact(db => {
    for (let i = 0; i < 3; i += 1) db.jobs.push({ id: "job_dead_" + i, type: "graph-node", status: "dead_letter", lastError: "ENOENT: workspace 42 missing", resourceClass: "cpu" });
  });
  const auditor = await createSupervisor("auditor", { pollMs: 20 });
  await auditor.boot();
  try {
    const first = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Audit 1" });
    const done = await runOne(auditor, first.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.result.checks.devRuntime.ok, true);
    assert.equal(done.result.checks.builder.status, "offline");
    // System B's own schedule may have audited first; either way exactly one task exists.
    assert.equal((await state.listTasks({ system: "builder" })).filter(task => task.origin?.type === "system-b").length, 1);
    const findings = await state.listFindings({ status: "open" });
    assert.ok(findings.some(item => item.fingerprint === "process:builder:offline"));
    const repeat = findings.find(item => item.fingerprint.startsWith("repeat-failure:job:graph-node"));
    assert.ok(repeat.engineeringTaskId);
    const engineering = await state.getTask(repeat.engineeringTaskId);
    assert.equal(engineering.system, "builder");
    assert.equal(engineering.kind, "code.change");
    assert.equal(engineering.scopeArea, "dev-workflows");
    assert.equal(engineering.origin.type, "system-b");

    // The same failure seen again does not file a second task.
    const second = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Audit 2" });
    const again = await runOne(auditor, second.id);
    assert.equal(again.result.engineeringTasks, 0);
    assert.equal((await state.listTasks({ system: "builder" })).filter(task => task.origin?.type === "system-b").length, 1);

    // When the failures are gone the finding resolves.
    await transact(db => { db.jobs = db.jobs.filter(job => !job.id.startsWith("job_dead_")); });
    const third = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Audit 3" });
    await runOne(auditor, third.id);
    const resolved = (await state.listFindings({ status: "resolved" })).find(item => item.id === repeat.id);
    assert.ok(resolved, "the repeated-failure finding resolved once the failures cleared");
  } finally {
    await auditor.shutdown();
    health.close();
    delete process.env.RAZEKIT_DEV_BASE_URL;
  }
});

test("the daily report says plainly that email is not configured instead of pretending to send", async () => {
  const auditor = await createSupervisor("auditor", { pollMs: 20, env: { ...process.env, ADMIN_EMAIL: "" } });
  await auditor.boot();
  const task = await state.enqueueTask({ system: "auditor", kind: "report.daily", title: "Daily report" });
  const done = await runOne(auditor, task.id);
  assert.equal(done.status, "completed");
  assert.equal(done.result.notification.sent, false);
  assert.match(done.result.notification.reason, /ADMIN_EMAIL is not configured/);
  await auditor.shutdown();
});
