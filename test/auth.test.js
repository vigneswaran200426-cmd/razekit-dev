import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// DEV's own accounts, end to end. The unit half exercises the module; the HTTP
// half spawns the real server in session mode, because the server is where a
// request from outside is either identified or refused.

const unitDir = await mkdtemp(path.join(os.tmpdir(), "razekit-auth-unit-"));
process.env.RAZEKIT_DATA_DIR = unitDir;

const auth = await import("../src/auth.js");
const { loadDb } = await import("../src/store.js");

const PASSWORD = "correct horse battery staple";

test("passwords are stored as scrypt hashes and verified in constant time", async () => {
  const stored = await auth.hashPassword(PASSWORD);
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!stored.includes(PASSWORD));
  assert.equal(await auth.verifyPassword(PASSWORD, stored), true);
  assert.equal(await auth.verifyPassword(PASSWORD + "!", stored), false);
  assert.equal(await auth.verifyPassword(PASSWORD, "not-a-hash"), false);
  await assert.rejects(() => auth.hashPassword("short"), /at least 12/);
});

test("accounts: unique emails, owner only via bootstrap, sessions stored as hashes", async () => {
  const member = await auth.createUser({ email: "Member@Example.com", password: PASSWORD });
  assert.equal(member.email, "member@example.com");
  assert.equal(member.role, "member");
  await assert.rejects(() => auth.createUser({ email: "member@example.com", password: PASSWORD }), (e) => e.status === 409);
  await assert.rejects(() => auth.createUser({ email: "x@example.com", password: PASSWORD, role: "owner" }), /already has an owner/);

  const session = await auth.login({ email: "member@example.com", password: PASSWORD });
  assert.ok(session.token.length >= 40);
  const db = await loadDb();
  assert.ok(db.sessions.every((s) => s.tokenHash !== session.token), "the raw token is never stored");
  assert.ok(db.users.every((u) => !JSON.stringify(u).includes(PASSWORD)), "the password is never stored");

  const resolved = await auth.resolveSession(session.token);
  assert.equal(resolved.user.email, "member@example.com");
  assert.equal(await auth.revokeSession(session.token), true);
  assert.equal(await auth.resolveSession(session.token), null);
});

test("wrong passwords are refused alike for unknown accounts, and repeated failures lock out", async () => {
  auth.resetLoginFailures();
  await assert.rejects(() => auth.login({ email: "nobody@example.com", password: PASSWORD }), (e) => e.status === 401 && /incorrect/.test(e.message));
  await assert.rejects(() => auth.login({ email: "member@example.com", password: "wrong password here" }), (e) => e.status === 401);
  for (let i = 0; i < 9; i++) {
    await auth.login({ email: "member@example.com", password: "wrong password here" }).catch(() => {});
  }
  await assert.rejects(() => auth.login({ email: "member@example.com", password: PASSWORD }), (e) => e.status === 429);
  auth.resetLoginFailures();
  const ok = await auth.login({ email: "member@example.com", password: PASSWORD });
  assert.ok(ok.token);
});

test("disabling an account ends its sessions and blocks sign-in", async () => {
  const users = await auth.listUsers();
  const member = users.find((u) => u.email === "member@example.com");
  const session = await auth.login({ email: "member@example.com", password: PASSWORD });
  await auth.setUserStatus(member.id, "disabled");
  assert.equal(await auth.resolveSession(session.token), null);
  await assert.rejects(() => auth.login({ email: "member@example.com", password: PASSWORD }), (e) => e.status === 403);
});

test("bootstrap needs the configured token and an empty deployment", async () => {
  const fresh = await mkdtemp(path.join(os.tmpdir(), "razekit-auth-boot-"));
  // A separate process, so the store points at an empty data directory.
  const script = `
    process.env.RAZEKIT_DATA_DIR = ${JSON.stringify(fresh)};
    process.env.RAZEKIT_BOOTSTRAP_TOKEN = "b".repeat(32);
    const auth = await import(${JSON.stringify(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "auth.js"))});
    const out = {};
    try { await auth.bootstrapOwner({ token: "wrong".repeat(7), email: "o@example.com", password: ${JSON.stringify(PASSWORD)} }); } catch (e) { out.wrong = e.status; }
    out.owner = (await auth.bootstrapOwner({ token: "b".repeat(32), email: "o@example.com", password: ${JSON.stringify(PASSWORD)} })).role;
    try { await auth.bootstrapOwner({ token: "b".repeat(32), email: "p@example.com", password: ${JSON.stringify(PASSWORD)} }); } catch (e) { out.second = e.status; }
    console.log(JSON.stringify(out));
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let data = "";
    child.stdout.on("data", (chunk) => (data += chunk));
    child.on("exit", (code) => (code === 0 ? resolve(data) : reject(new Error("exit " + code))));
  });
  assert.deepEqual(JSON.parse(output), { wrong: 403, owner: "owner", second: 409 });
  await rm(fresh, { recursive: true, force: true });
});

// ── HTTP, against the real server in session mode ─────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "server.js");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-auth-http-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-auth-ws-"));
const PORT = 3800 + Math.floor(Math.random() * 400);
const BASE = "http://127.0.0.1:" + PORT;
const BOOTSTRAP = "bootstrap-token-" + "x".repeat(24);
const OPERATOR = "operator-token-for-tests";
let child = null;

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE + "/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server never became healthy");
}

async function call(method, pathname, { body, cookie, headers = {} } = {}) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null), setCookie: response.headers.get("set-cookie") };
}

function cookieFrom(setCookie) {
  return setCookie.split(";")[0];
}

test.before(async () => {
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RAZEKIT_DATA_DIR: dataDir,
      RAZEKIT_WORKSPACE_ROOT: workspaceDir,
      RAZEKIT_STORE: "json",
      RAZEKIT_MODEL_MODE: "test",
      RAZEKIT_AUTH_MODE: "session",
      RAZEKIT_BOOTSTRAP_TOKEN: BOOTSTRAP,
      RAZEKIT_SIGNUP: "open",
      RAZEKIT_ADMIN_TOKEN: OPERATOR,
      RAZEKIT_COORDINATOR_ENABLED: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForHealth();
});

test.after(async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(unitDir, { recursive: true, force: true });
});

test("http: an unauthenticated caller is refused, and the login page is public", async () => {
  assert.equal((await call("GET", "/api/tasks")).status, 401);
  assert.equal((await call("GET", "/api/tasks", { headers: { "x-razekit-tenant-id": "forged" } })).status, 401);
  const page = await fetch(BASE + "/login");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in to RazeKit DEV/);
  const status = await call("GET", "/auth/status");
  assert.deepEqual(status.body, { mode: "session", signupOpen: true, needsBootstrap: true });
});

test("http: sign-up waits for the owner; bootstrap creates the owner once", async () => {
  assert.equal((await call("POST", "/auth/signup", { body: { email: "early@example.com", password: PASSWORD } })).status, 403);
  assert.equal((await call("POST", "/auth/bootstrap", { body: { token: "nope", email: "owner@example.com", password: PASSWORD } })).status, 403);
  const owner = await call("POST", "/auth/bootstrap", { body: { token: BOOTSTRAP, email: "owner@example.com", password: PASSWORD } });
  assert.equal(owner.status, 201);
  assert.equal(owner.body.user.role, "owner");
  assert.equal((await call("POST", "/auth/bootstrap", { body: { token: BOOTSTRAP, email: "again@example.com", password: PASSWORD } })).status, 409);
});

test("http: a session cookie identifies the caller, scopes their tasks, and logout ends it", async () => {
  const login = await call("POST", "/auth/login", { body: { email: "owner@example.com", password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.match(login.setCookie, /rk_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  const cookie = cookieFrom(login.setCookie);

  const me = await call("GET", "/auth/me", { cookie });
  assert.equal(me.body.user.email, "owner@example.com");
  assert.equal(me.body.user.role, "owner");

  const tasks = await call("GET", "/api/tasks", { cookie, headers: { "x-razekit-tenant-id": "someone-else" } });
  assert.equal(tasks.status, 200, "a forged tenant header is ignored, not trusted");

  assert.equal((await call("POST", "/auth/logout", { cookie })).status, 200);
  assert.equal((await call("GET", "/api/tasks", { cookie })).status, 401);
});

test("http: members cannot reach the internal surface; the operator token and the owner can", async () => {
  const signup = await call("POST", "/auth/signup", { body: { email: "member@example.com", password: PASSWORD } });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.role, "member");
  const member = cookieFrom(signup.setCookie);
  assert.equal((await call("GET", "/internal/infrastructure/status", { cookie: member })).status, 403);
  assert.equal((await call("GET", "/admin/users", { cookie: member })).status, 403);

  assert.equal((await call("GET", "/internal/infrastructure/status", { headers: { "x-razekit-admin-token": OPERATOR } })).status, 200);
  assert.equal((await call("GET", "/internal/infrastructure/status", { headers: { "x-razekit-admin-token": "wrong" } })).status, 401);

  const owner = cookieFrom((await call("POST", "/auth/login", { body: { email: "owner@example.com", password: PASSWORD } })).setCookie);
  const users = await call("GET", "/admin/users", { cookie: owner });
  assert.equal(users.status, 200);
  assert.ok(users.body.every((u) => !("passwordHash" in u)), "no hash ever leaves the server");
  assert.deepEqual(users.body.map((u) => u.email).sort(), ["member@example.com", "owner@example.com"]);
});

test("http: cross-origin writes are refused", async () => {
  const owner = cookieFrom((await call("POST", "/auth/login", { body: { email: "owner@example.com", password: PASSWORD } })).setCookie);
  const refused = await call("POST", "/auth/logout", { cookie: owner, headers: { origin: "https://evil.example" } });
  assert.equal(refused.status, 403);
  const sameOrigin = await call("POST", "/auth/logout", { cookie: owner, headers: { origin: BASE } });
  assert.equal(sameOrigin.status, 200);
});
