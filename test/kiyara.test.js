import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

// Kiyara against the real server in session mode: what she says comes from the
// store, what she does goes through the caller's own permissions, and she never
// reports an action as done before the target process confirms it.

for (const name of ["AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) delete process.env[name];
const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-kiyara-"));
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = "http://127.0.0.1:" + PORT;
const BOOTSTRAP = "bootstrap-token-" + "k".repeat(24);
const PASSWORD = "correct horse battery staple 77";
Object.assign(process.env, {
  PORT: String(PORT),
  RAZEKIT_DATA_DIR: dataDir,
  RAZEKIT_WORKSPACE_ROOT: path.join(dataDir, "ws"),
  RAZEKIT_STORE: "json",
  RAZEKIT_MODEL_MODE: "test",
  RAZEKIT_AUTH_MODE: "session",
  RAZEKIT_BOOTSTRAP_TOKEN: BOOTSTRAP,
  RAZEKIT_SIGNUP: "open",
  RAZEKIT_ADMIN_TOKEN: "operator-token-for-kiyara-tests",
  RAZEKIT_COORDINATOR_ENABLED: "false"
});

const { server, runtimeCoordinator } = await import("../src/server.js");
const { parseIntent } = await import("../src/kiyara.js");
const state = await import("../src/ops-state.js");
const { transact } = await import("../src/store.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(method, pathname, { body, cookie } = {}) {
  const response = await fetch(BASE + pathname, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: response.status, body: json, text, headers: response.headers };
}

let owner, member, memberId;
test.before(async () => {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await sleep(50); }
  assert.equal((await call("POST", "/auth/bootstrap", { body: { token: BOOTSTRAP, email: "owner@example.com", password: PASSWORD } })).status, 201);
  owner = (await call("POST", "/auth/login", { body: { email: "owner@example.com", password: PASSWORD } })).headers.get("set-cookie").split(";")[0];
  await call("POST", "/auth/signup", { body: { email: "member@example.com", password: PASSWORD } });
  member = (await call("POST", "/auth/login", { body: { email: "member@example.com", password: PASSWORD } })).headers.get("set-cookie").split(";")[0];
  memberId = (await call("GET", "/auth/me", { cookie: member })).body.user;
});
test.after(async () => {
  runtimeCoordinator.stop();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

test("intents are literal: commands are recognised, everything else is admitted as not understood", () => {
  assert.deepEqual(parseIntent("Pause System A"), { intent: "control", targetType: "system", target: "builder", action: "pause" });
  assert.deepEqual(parseIntent("resume konami!"), { intent: "control", targetType: "agent", target: "konami", action: "resume" });
  assert.equal(parseIntent("What's happening?").intent, "status");
  assert.equal(parseIntent("my tasks").intent, "tasks");
  assert.equal(parseIntent("delete the database").intent, "unknown");
  assert.equal(parseIntent("pause everything").intent, "unknown");
});

test("the page and API are for signed-in accounts only", async () => {
  const anon = await call("GET", "/kiyara");
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login?next=%2Fkiyara");
  assert.equal((await call("GET", "/api/kiyara/state")).status, 401);
  assert.equal((await call("POST", "/api/kiyara/message", { body: { text: "status" } })).status, 401);
  const page = await call("GET", "/kiyara", { cookie: member });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.ok(!/innerHTML/.test(page.text), "the page never inserts data as markup");
});

test("her state comes from the caller's own tasks: idle, then approval, then working", async () => {
  let view = (await call("GET", "/api/kiyara/state", { cookie: member })).body;
  assert.equal(view.state, "idle");
  assert.equal(view.systems, undefined, "members do not see the supervisors");
  assert.equal(view.voice.available, false);
  const now = new Date().toISOString();
  const task = { id: "task_kiyara_1", tenantId: memberId.tenantId, userId: memberId.id, title: "Landing page", status: "awaiting_budget", createdAt: now, updatedAt: now };
  await transact(db => { db.tasks.push(task); });
  view = (await call("GET", "/api/kiyara/state", { cookie: member })).body;
  assert.equal(view.state, "approval_needed");
  assert.equal(view.focus.id, "task_kiyara_1");
  assert.deepEqual(view.evidence, [{ label: "Task task_kiyara_1", href: "/api/tasks/task_kiyara_1" }]);
  await transact(db => { db.tasks.find(t => t.id === "task_kiyara_1").status = "running"; });
  const reply = (await call("POST", "/api/kiyara/message", { cookie: member, body: { text: "status" } })).body;
  assert.equal(reply.state, "working");
  assert.match(reply.reply, /Landing page/);
  assert.equal((await call("GET", "/api/kiyara/state", { cookie: owner })).body.focus, null, "another account's task is not the owner's");
});

test("a member cannot control anything through her, and nothing is requested", async () => {
  const count = async () => (await (await import("../src/store.js")).loadDb()).opsControlRequests.length;
  const before = await count();
  const r = (await call("POST", "/api/kiyara/message", { cookie: member, body: { text: "pause system a" } })).body;
  assert.equal(r.refused, true);
  assert.equal(r.proposal, undefined);
  assert.equal((await call("POST", "/api/kiyara/action", { cookie: member, body: { targetType: "system", target: "builder", action: "pause", confirm: true } })).status, 403);
  assert.equal(await count(), before, "no control request was created");
});

test("an owner's command is proposed, confirmed, requested, and narrated only as the process reports it", async () => {
  const proposal = (await call("POST", "/api/kiyara/message", { cookie: owner, body: { text: "pause system b" } })).body;
  assert.deepEqual(proposal.proposal, { targetType: "system", target: "auditor", action: "pause" });
  assert.match(proposal.reply, /is not configured, so no process is there to accept it/, "she says when nothing can act on it");
  await state.writeHeartbeat("auditor", { processId: "auditor-live", status: "running" });
  const live = (await call("POST", "/api/kiyara/message", { cookie: owner, body: { text: "pause system b" } })).body;
  assert.doesNotMatch(live.reply, /no process is there/, "no caveat while System B is live");
  assert.equal((await call("POST", "/api/kiyara/action", { cookie: owner, body: { ...proposal.proposal } })).status, 409, "no confirmation, no request");
  assert.equal((await call("POST", "/api/kiyara/action", { cookie: owner, body: { targetType: "system", target: "everything", action: "pause", confirm: true } })).status, 400);
  const done = await call("POST", "/api/kiyara/action", { cookie: owner, body: { ...proposal.proposal, confirm: true } });
  assert.equal(done.status, 202);
  assert.equal(done.body.request.status, "requested");
  assert.match(done.body.reply, /has not accepted it yet/);
  const id = done.body.request.id;
  let told = (await call("GET", "/api/kiyara/requests/" + id, { cookie: owner })).body;
  assert.equal(told.request.status, "requested");
  // The auditor process accepts and completes it; only then does she say so.
  const accepted = await state.acceptControlRequests("system", "auditor", "auditor-test-process");
  assert.equal(accepted.length, 1);
  told = (await call("GET", "/api/kiyara/requests/" + id, { cookie: owner })).body;
  assert.match(told.reply, /accepted/);
  await state.resolveControlRequest(id, { status: "completed", evidence: { mode: "paused" } });
  told = (await call("GET", "/api/kiyara/requests/" + id, { cookie: owner })).body;
  assert.equal(told.request.status, "completed");
  assert.match(told.reply, /confirmed: pause is done/);
  const audit = await state.listAdminAudit({ limit: 20 });
  assert.ok(audit.some(entry => entry.action === "system.pause" && entry.target === "auditor" && entry.details?.via === "kiyara"));
  assert.equal((await call("GET", "/api/kiyara/requests/" + id, { cookie: member })).status, 403);
});

test("anything outside her commands gets an honest answer, not an improvised one", async () => {
  const r = (await call("POST", "/api/kiyara/message", { cookie: owner, body: { text: "write me a poem about deploys" } })).body;
  assert.equal(r.intent, "unknown");
  assert.match(r.reply, /don't understand that yet/);
  assert.equal((await call("POST", "/api/kiyara/message", { cookie: owner, body: { text: "x".repeat(2001) } })).status, 400);
});
