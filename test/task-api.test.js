import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The HTTP contract, against the real server.
//
// Every other test in this repository imports the modules directly. That proves
// the modules and proves nothing about the endpoint in front of them — and the
// endpoint is where the authorization decision is actually made, because it is
// the only place a request from outside arrives. A rule enforced in a module
// but skipped by the route that calls it is not enforced.
//
// So this spawns src/server.js as its own process, with its own data directory,
// and talks to it over a socket.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "server.js");

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-api-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-api-ws-"));
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = "http://127.0.0.1:" + PORT;

let child = null;

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE + "/health");
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("The server never became healthy on " + BASE);
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
      RAZEKIT_ADMIN_TOKEN: "api-test-admin-token",
      // The loop must not start executing the tasks this test creates: these
      // assertions are about what was authorized, not about what ran.
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
    await new Promise(resolve => child.on("exit", resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let userSeq = 0;
function headers() {
  userSeq += 1;
  return {
    "content-type": "application/json",
    "x-razekit-tenant-id": "api-tenant-" + userSeq,
    "x-razekit-user-id": "api-user-" + userSeq
  };
}

async function post(pathname, bodyObject, requestHeaders) {
  const response = await fetch(BASE + pathname, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(bodyObject)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const DRAFT = {
  taskType: "website",
  title: "Landing page",
  originalRequest: "Build a one-page landing site with a contact form",
  specification: "Build a one-page landing site with a contact form"
};

test("a task cannot be created without a confirmed preview", async () => {
  const h = headers();
  const result = await post("/api/tasks", {
    ...DRAFT,
    maxBudget: 20,
    acceptAutonomousExecution: true
  }, h);

  assert.equal(result.status, 400);
  assert.match(result.body.error, /confirmed task preview is required/i);
});

test("preview then confirm creates a task authorized to exactly what was shown", async () => {
  const h = headers();

  const previewed = await post("/api/tasks/preview", { ...DRAFT, level: "mid" }, h);
  assert.equal(previewed.status, 200);
  const preview = previewed.body;

  assert.equal(preview.authorizationPreview.grantsNothing, true);
  assert.ok(preview.fingerprint);
  assert.ok(preview.budget.expected > 0);

  const created = await post("/api/tasks", {
    ...DRAFT,
    previewId: preview.id,
    previewFingerprint: preview.fingerprint,
    maxBudget: preview.budget.maximum,
    acceptAutonomousExecution: true
  }, h);

  assert.equal(created.status, 201, JSON.stringify(created.body));
  const task = created.body.task;

  assert.equal(task.executionLevel, "mid");
  assert.equal(task.authorization.previewId, preview.id);
  assert.equal(task.authorization.previewFingerprint, preview.fingerprint);
  // Exactly what the preview showed — not what the request body asked for.
  assert.deepEqual(task.authorization.toolScopes, preview.authorizationPreview.preauthorizedScopes);
  assert.deepEqual(task.requestedTools, preview.authorizationPreview.tools);
});

test("tools added between the preview and the confirmation are refused", async () => {
  const h = headers();

  const previewed = await post("/api/tasks/preview", { ...DRAFT, level: "low" }, h);
  const preview = previewed.body;

  // The classic shape of this bug: the body carries more than the screen did.
  const created = await post("/api/tasks", {
    ...DRAFT,
    previewId: preview.id,
    previewFingerprint: preview.fingerprint,
    requestedTools: ["filesystem", "shell", "deploy-web", "database"],
    maxBudget: 20,
    acceptAutonomousExecution: true
  }, h);

  assert.equal(created.status, 201, JSON.stringify(created.body));
  const task = created.body.task;

  // The extra tools simply do not appear: the confirmed preview decides.
  assert.deepEqual(task.requestedTools, preview.authorizationPreview.tools);
  assert.ok(!task.authorization.toolScopes.includes("deployment:deploy"));
  assert.ok(!task.authorization.toolScopes.includes("database:write"));
});

test("a tampered fingerprint is refused", async () => {
  const h = headers();
  const preview = (await post("/api/tasks/preview", { ...DRAFT, level: "mid" }, h)).body;

  const created = await post("/api/tasks", {
    ...DRAFT,
    previewId: preview.id,
    previewFingerprint: "f".repeat(32),
    maxBudget: 20,
    acceptAutonomousExecution: true
  }, h);

  assert.equal(created.status, 400);
  assert.match(created.body.errors.join(" "), /changed after it was shown/i);
});

test("one preview starts one task", async () => {
  const h = headers();
  const preview = (await post("/api/tasks/preview", { ...DRAFT, level: "mid" }, h)).body;

  const confirm = () => post("/api/tasks", {
    ...DRAFT,
    previewId: preview.id,
    previewFingerprint: preview.fingerprint,
    maxBudget: 20,
    acceptAutonomousExecution: true
  }, h);

  assert.equal((await confirm()).status, 201);
  const second = await confirm();
  assert.equal(second.status, 400);
  assert.match(second.body.errors.join(" "), /already been used/i);
});

test("a custom policy that asks for a deployment is refused at the endpoint", async () => {
  const h = headers();
  const result = await post("/api/tasks/preview", {
    ...DRAFT,
    level: "custom",
    custom: {
      tools: ["filesystem", "deploy-web"],
      preauthorizedScopes: ["workspace:write", "deployment:deploy"]
    }
  }, h);

  assert.equal(result.status, 400);
  assert.match(result.body.errors.join(" "), /cannot be pre-authorized/i);
});

test("the model/step endpoint no longer runs a model phase outside the graph", async () => {
  const response = await fetch(BASE + "/internal/agents/agent_whatever/model/step", {
    method: "POST",
    headers: { ...headers(), "x-razekit-admin-token": "api-test-admin-token" },
    body: "{}"
  });

  assert.equal(response.status, 410);
  const body = await response.json();
  assert.match(body.error, /graph nodes/i);
  assert.match(body.use, /\/advance$/);
});

test("execution levels are published with what they still stop for", async () => {
  const response = await fetch(BASE + "/api/execution-levels", { headers: headers() });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.levels.length, 3);
  for (const level of body.levels) {
    assert.ok(level.alwaysAsks.includes("deployment:deploy"));
    assert.ok(level.summary.length > 0);
  }
});
