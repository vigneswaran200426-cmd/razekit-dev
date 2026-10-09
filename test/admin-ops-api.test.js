import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The admin control center, end to end: the real HTTP server, real session
// accounts, and real supervisor loops for System A and System B, all on one
// file store in one process (the file store is per-process by design). A
// second, separate server process is then started on the same data to prove
// that what was saved survives a restart and that nothing is invented on boot.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-admin-ops-"));
const PORT = 4200 + Math.floor(Math.random() * 400);
const BASE = "http://127.0.0.1:" + PORT;
const BOOTSTRAP = "bootstrap-token-" + "y".repeat(24);
const OPERATOR = "operator-token-for-admin-ops-tests";
const PASSWORD = "correct horse battery staple 42";
Object.assign(process.env, {
  PORT: String(PORT),
  RAZEKIT_DATA_DIR: dataDir,
  RAZEKIT_WORKSPACE_ROOT: path.join(dataDir, "ws"),
  RAZEKIT_STORE: "json",
  RAZEKIT_MODEL_MODE: "test",
  RAZEKIT_AUTH_MODE: "session",
  RAZEKIT_BOOTSTRAP_TOKEN: BOOTSTRAP,
  RAZEKIT_SIGNUP: "open",
  RAZEKIT_ADMIN_TOKEN: OPERATOR,
  RAZEKIT_COORDINATOR_ENABLED: "true",
  RAZEKIT_TICK_MS: "150",
  RAZEKIT_OPS_ALLOW_JSON_STORE: "true",
  RAZEKIT_OPS_WORKSPACE_ROOT: path.join(dataDir, "ops-ws"),
  RAZEKIT_OPS_LOG_DIR: path.join(dataDir, "ops-logs"),
  RAZEKIT_OPS_HEARTBEAT_MS: "1000"
});

const { server, runtimeCoordinator } = await import("../src/server.js");
const { Supervisor } = await import("../src/ops-supervisor.js");
const state = await import("../src/ops-state.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, { timeoutMs = 10_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + label);
    await sleep(40);
  }
}

async function call(method, pathname, { body, cookie, headers = {}, base = BASE } = {}) {
  const response = await fetch(base + pathname, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, body: json, text, headers: response.headers };
}

let ownerCookie;
let memberCookie;
const supervisors = [];
const loops = [];

function startLoop(sup) {
  const controller = new AbortController();
  const done = (async () => {
    try { await sup.boot(); } catch (error) { sup.bootError = error; return; }
    while (!controller.signal.aborted) {
      await sup.tick().catch(() => {});
      await sleep(30);
    }
  })();
  loops.push({ sup, controller, done });
}

test.before(async () => {
  await until(async () => (await call("GET", "/health").catch(() => ({}))).status === 200, { label: "server" });
  const boot = await call("POST", "/auth/bootstrap", { body: { token: BOOTSTRAP, email: "owner@example.com", password: PASSWORD } });
  assert.equal(boot.status, 201, boot.text);
  const login = await call("POST", "/auth/login", { body: { email: "owner@example.com", password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  ownerCookie = login.headers.get("set-cookie").split(";")[0];
  await call("POST", "/auth/signup", { body: { email: "member@example.com", password: PASSWORD } });
  const member = await call("POST", "/auth/login", { body: { email: "member@example.com", password: PASSWORD } });
  memberCookie = member.headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  for (const loop of loops) loop.controller.abort();
  await Promise.all(loops.map(loop => loop.done));
  for (const loop of loops) await loop.sup.shutdown().catch(() => {});
  runtimeCoordinator.stop();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

test("the admin page: sign-in redirect, members refused, owners served", async () => {
  const anon = await call("GET", "/admin/24-7");
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login?next=%2Fadmin%2F24-7");
  assert.equal((await call("GET", "/admin/24-7", { cookie: memberCookie })).status, 403);
  const page = await call("GET", "/admin/24-7", { cookie: ownerCookie });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.text, /Admin Control Center/);
  assert.match(page.text, /\/api\/admin\/ops\/dashboard/);
  const home = await call("GET", "/", { cookie: ownerCookie });
  assert.match(home.text, /href=\\?"\/admin\/24-7\\?"/, "the main dashboard links to the admin page");
});

test("every privileged endpoint is enforced on the server", async () => {
  for (const [method, route] of [["GET", "/api/admin/ops/dashboard"], ["POST", "/api/admin/ops/systems/builder/control"], ["PUT", "/api/admin/ops/models/coding"], ["POST", "/api/admin/ops/emergency-stop"], ["GET", "/api/admin/ops/logs"]]) {
    assert.equal((await call(method, route, { body: method === "GET" ? undefined : {} })).status, 401, method + " " + route + " anonymous");
    assert.equal((await call(method, route, { cookie: memberCookie, body: method === "GET" ? undefined : {} })).status, 403, method + " " + route + " member");
  }
  assert.equal((await call("GET", "/api/admin/ops/dashboard", { headers: { "x-razekit-admin-token": OPERATOR } })).status, 200);
  assert.equal((await call("GET", "/api/admin/ops/dashboard", { headers: { "x-razekit-admin-token": "wrong" } })).status, 401);
});

test("with no supervisor processes, both systems are 'not configured' and controls stay 'requested'", async () => {
  const dash = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.systems.builder.process.status, "not_configured");
  assert.equal(dash.body.systems.auditor.process.status, "not_configured");
  assert.equal(dash.body.models.gateway.status, "not_configured");
  assert.equal(dash.body.compute.gpu.state, "not_configured");
  assert.equal(dash.body.compute.gpuControlsAvailable, false);
  assert.equal(dash.body.models.config.slots.coding.model, "qwen3-coder:30b");
  assert.equal(dash.body.models.config.slots.reasoning.model, "gpt-oss:20b");

  const needsConfirm = await call("POST", "/api/admin/ops/systems/auditor/control", { cookie: ownerCookie, body: { action: "pause" } });
  assert.equal(needsConfirm.status, 409);
  const start = await call("POST", "/api/admin/ops/systems/auditor/control", { cookie: ownerCookie, body: { action: "start" } });
  assert.equal(start.status, 202);
  assert.equal(start.body.request.status, "requested", "an HTTP 202 is a record of the request, not of success");
  await sleep(300);
  const again = await call("GET", "/api/admin/ops/control-requests/" + start.body.request.id, { cookie: ownerCookie });
  assert.equal(again.body.request.status, "requested", "no process exists to accept it");

  const gpu = await call("POST", "/api/admin/ops/compute/gpu", { cookie: ownerCookie, body: { action: "start", confirm: true } });
  assert.equal(gpu.status, 409);
  assert.match(gpu.body.error, /gateway process is not_configured/);
});

test("heartbeats: fresh is running, late is stale, old is offline", async () => {
  const now = Date.now();
  await state.writeHeartbeat("gateway", { processId: "gw-test", status: "running" }, now - 5_000);
  let dash = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
  assert.equal(dash.body.models.gateway.status, "stale");
  await state.writeHeartbeat("gateway", { processId: "gw-test", status: "running" }, now - 30 * 60_000);
  dash = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
  assert.equal(dash.body.models.gateway.status, "offline");
  await state.writeHeartbeat("gateway", { processId: "gw-test", status: "running" }, now);
  dash = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
  assert.equal(dash.body.models.gateway.status, "running");
  await state.writeHeartbeat("gateway", { processId: "gw-test", status: "stopped" }, now - 30 * 60_000);
});

test("System A and System B are operated independently through the API, confirmed by their processes", async () => {
  const blockers = {};
  const handlers = system => ({
    async run(ctx) {
      await ctx.checkpointWrite("working", { system });
      await new Promise((resolve, reject) => {
        blockers[ctx.task.id] = resolve;
        ctx.signal.addEventListener("abort", () => { delete blockers[ctx.task.id]; reject(ctx.signal.reason); }, { once: true });
      });
      return { summary: system + " finished " + ctx.task.id, tests: system === "builder" ? { passed: true, total: 3, pass: 3, fail: 0, skipped: 0, failing: [] } : undefined };
    }
  });
  // Each system gets its own environment, without the server's secrets: the
  // supervisor refuses to start otherwise (checked in the next assertion).
  const supervisorEnv = { ...process.env, RAZEKIT_ADMIN_TOKEN: "", RAZEKIT_BOOTSTRAP_TOKEN: "" };
  await assert.rejects(() => new Supervisor({ system: "builder", handlers: handlers("builder") }).boot(), /Permission isolation violated/);
  const builder = new Supervisor({ system: "builder", handlers: handlers("builder"), pollMs: 30, leaseMs: 3000, env: supervisorEnv });
  const auditor = new Supervisor({ system: "auditor", handlers: handlers("auditor"), pollMs: 30, leaseMs: 3000, env: supervisorEnv });
  startLoop(builder);
  startLoop(auditor);

  // The earlier 'start' request for System B is accepted once its process exists.
  let dash = await until(async () => {
    const d = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
    return d.body.systems.builder.process.status === "running" && d.body.systems.auditor.process.status === "running" ? d : null;
  }, { label: "both running" });
  assert.equal(dash.body.systems.builder.process.heartbeat.processId, builder.processId);

  const queued = await call("POST", "/api/admin/ops/systems/builder/tasks", { cookie: ownerCookie, body: { kind: "code.change", scopeArea: "dev-frontend", title: "Improve the admin page", goal: "x" } });
  assert.equal(queued.status, 201);
  assert.equal((await call("POST", "/api/admin/ops/systems/builder/tasks", { cookie: ownerCookie, body: { kind: "code.change", scopeArea: "marketing", title: "Out of scope" } })).status, 400);
  const auditTask = await call("POST", "/api/admin/ops/systems/auditor/tasks", { cookie: ownerCookie, body: { kind: "audit.cycle", title: "Manual audit" } });
  const builderTaskId = queued.body.task.id;
  const auditorTaskId = auditTask.body.task.id;
  dash = await until(async () => {
    const d = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
    return d.body.systems.builder.currentTask?.id === builderTaskId && d.body.systems.auditor.currentTask?.id === auditorTaskId ? d : null;
  }, { label: "both tasks running" });

  // Pause System A only.
  const pause = await call("POST", "/api/admin/ops/systems/builder/control", { cookie: ownerCookie, body: { action: "pause", confirm: true } });
  const paused = await until(async () => {
    const r = await call("GET", "/api/admin/ops/control-requests/" + pause.body.request.id, { cookie: ownerCookie });
    return r.body.request.status === "completed" ? r.body.request : null;
  }, { label: "pause completed" });
  assert.equal(paused.acceptedBy, builder.processId);
  dash = await until(async () => {
    const d = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
    return d.body.systems.builder.process.status === "paused" ? d : null;
  }, { label: "builder paused" });
  assert.equal(dash.body.systems.builder.persistedMode, "paused");
  assert.equal(dash.body.systems.auditor.process.status, "running", "System B is unaffected");
  assert.equal(dash.body.systems.auditor.currentTask.id, auditorTaskId);
  assert.equal(dash.body.systems.builder.lastCheckpoint.step, "working");

  // Stop System B's current task.
  const stop = await call("POST", "/api/admin/ops/systems/auditor/control", { cookie: ownerCookie, body: { action: "stop_task", taskId: auditorTaskId, confirm: true } });
  const stopped = await until(async () => {
    const r = await call("GET", "/api/admin/ops/control-requests/" + stop.body.request.id, { cookie: ownerCookie });
    return r.body.request.status === "completed" ? r.body.request : null;
  }, { label: "stop completed" });
  assert.equal(stopped.evidence.finalStatus, "cancelled");

  // Resume System A; its interrupted task resumes and completes.
  const resume = await call("POST", "/api/admin/ops/systems/builder/control", { cookie: ownerCookie, body: { action: "resume" } });
  await until(async () => (await call("GET", "/api/admin/ops/control-requests/" + resume.body.request.id, { cookie: ownerCookie })).body.request.status === "completed", { label: "resume" });
  await until(() => blockers[builderTaskId], { label: "builder re-claimed" });
  blockers[builderTaskId]();
  dash = await until(async () => {
    const d = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
    return d.body.systems.builder.lastCompleted?.id === builderTaskId ? d : null;
  }, { label: "builder completed" });
  assert.equal(dash.body.systems.builder.lastTestResult.pass, 3);

  const logs = await call("GET", "/api/admin/ops/logs?source=builder", { cookie: ownerCookie });
  assert.ok(logs.body.events.length > 0);
  assert.ok(logs.body.events.every(event => event.source === "builder"));
  assert.ok(logs.body.events.some(event => event.action === "control.pause"));
});

test("Niomi and Konami are paused by the coordinator that runs them, not by the HTTP handler", async () => {
  const pause = await call("POST", "/api/admin/ops/agents/konami/control", { cookie: ownerCookie, body: { action: "pause", confirm: true } });
  assert.equal(pause.status, 202);
  assert.equal(pause.body.request.status, "requested");
  const done = await until(async () => {
    const r = await call("GET", "/api/admin/ops/control-requests/" + pause.body.request.id, { cookie: ownerCookie });
    return r.body.request.status === "completed" ? r.body.request : null;
  }, { label: "coordinator applied" });
  assert.match(done.acceptedBy, /^coordinator-/);
  const dash = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
  assert.equal(dash.body.agents.konami.availability.state, "paused");
  assert.equal(dash.body.agents.niomi.availability.state, "available");
  assert.notEqual(dash.body.agents.niomi.name, dash.body.systems.builder.name);
});

test("model assignments: validated, confirmed, audited", async () => {
  assert.equal((await call("PUT", "/api/admin/ops/models/coding", { cookie: ownerCookie, body: { model: "llama3:8b", confirm: "llama3:8b" } })).status, 400);
  assert.equal((await call("PUT", "/api/admin/ops/models/coding", { cookie: ownerCookie, body: { model: "devstral-small-2:24b" } })).status, 409);
  const ok = await call("PUT", "/api/admin/ops/models/coding", { cookie: ownerCookie, body: { model: "devstral-small-2:24b", confirm: "devstral-small-2:24b" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.previous, "qwen3-coder:30b");
  const back = await call("PUT", "/api/admin/ops/models/coding", { cookie: ownerCookie, body: { model: "qwen3-coder:30b", confirm: "qwen3-coder:30b" } });
  assert.equal(back.body.config.slots.coding.model, "qwen3-coder:30b");

  const testReq = await call("POST", "/api/admin/ops/models/reasoning/test", { cookie: ownerCookie, body: {} });
  assert.equal(testReq.status, 202);
  const inference = await call("GET", "/api/admin/ops/inference/" + testReq.body.request.id, { cookie: ownerCookie });
  assert.equal(inference.body.request.status, "queued", "without a gateway the test waits; it is never marked passed");

  const audit = await call("GET", "/api/admin/ops/audit", { cookie: ownerCookie });
  const actions = audit.body.entries.map(entry => entry.action + ":" + entry.outcome);
  assert.ok(actions.includes("model.assign:rejected"));
  assert.ok(actions.includes("model.assign:accepted"));
  assert.ok(actions.includes("system.pause:accepted"));
  assert.ok(audit.body.entries.every(entry => entry.actor === "owner@example.com"));
});

test("emergency stop is persisted on the server and halts both systems", async () => {
  assert.equal((await call("POST", "/api/admin/ops/emergency-stop", { cookie: ownerCookie, body: { engaged: true } })).status, 409);
  const engaged = await call("POST", "/api/admin/ops/emergency-stop", { cookie: ownerCookie, body: { engaged: true, confirm: "STOP", reason: "test" } });
  assert.equal(engaged.status, 200);
  const dash = await until(async () => {
    const d = await call("GET", "/api/admin/ops/dashboard", { cookie: ownerCookie });
    return d.body.systems.auditor.process.heartbeat?.statusReason?.startsWith("Emergency stop") ? d : null;
  }, { label: "auditor sees emergency" });
  assert.equal(dash.body.emergency.engaged, true);
  assert.equal(dash.body.agents.niomi.availability.state, "paused");
});

test("after a restart, a new server process shows the saved state and invents nothing", async () => {
  for (const loop of loops) loop.controller.abort();
  await Promise.all(loops.map(loop => loop.done));
  for (const loop of loops) await loop.sup.shutdown();
  loops.length = 0;

  const port = PORT + 1000;
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.js")], {
    env: { ...process.env, PORT: String(port), RAZEKIT_COORDINATOR_ENABLED: "false" },
    stdio: "ignore"
  });
  try {
    const base = "http://127.0.0.1:" + port;
    await until(async () => (await call("GET", "/health", { base }).catch(() => ({}))).status === 200, { label: "second server" });
    const dash = await call("GET", "/api/admin/ops/dashboard", { base, headers: { "x-razekit-admin-token": OPERATOR } });
    assert.equal(dash.status, 200);
    assert.equal(dash.body.emergency.engaged, true, "the emergency stop survived the restart");
    assert.equal(dash.body.systems.builder.persistedMode, "running");
    assert.equal(dash.body.systems.builder.process.status, "offline", "a stopped process is offline, not running");
    assert.equal(dash.body.systems.auditor.process.status, "offline");
    assert.equal(dash.body.agents.konami.control.mode, "paused");
    assert.equal(dash.body.models.config.version >= 3, true);
    const audit = await call("GET", "/api/admin/ops/audit", { base, headers: { "x-razekit-admin-token": OPERATOR } });
    assert.ok(audit.body.entries.some(entry => entry.action === "emergency.engage"));
  } finally {
    child.kill("SIGKILL");
  }
});
