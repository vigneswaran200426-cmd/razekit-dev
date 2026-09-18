import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-security-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-security-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_ADMIN_TOKEN = "test-admin-token";

const { id, loadDb, transact } = await import("../src/store.js");
const { TASK_STATUS, AGENT_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const {
  principalFromHeaders,
  ensureTenant,
  assertTenantActive,
  assertTaskAccess,
  writeAudit,
  issuePrincipalToken
} = await import("../src/tenant-security.js");
const {
  enforceTenantLimit,
  enforceActiveTaskLimit,
  setTenantLimits
} = await import("../src/abuse-controls.js");
const {
  DeterministicBillingAdapter,
  billingRegistry,
  reserveSpend,
  captureSpend,
  releaseSpend,
  chargeProvider
} = await import("../src/billing.js");
const {
  registerCredentialReference,
  issueTemporaryCredential,
  validateTemporaryCredential,
  revokeTemporaryCredential,
  listCredentialLeases
} = await import("../src/credential-vault.js");
const { InMemorySecretVault, SecretVaultRegistry } = await import("../src/secret-vault.js");
const {
  assertAdminToken,
  suspendTenant,
  resumeTenant,
  updateTenantLimits,
  tenantSecuritySummary,
  queryAudit
} = await import("../src/admin-control.js");

async function makeTask({ tenantId = "tenant-a", userId = "user-a", budget = 20 } = {}) {
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId,
    taskType: "website",
    title: "Security test",
    originalRequest: "Build a website",
    specification: "Build a website",
    requestedTools: [],
    estimatedBudget: 5,
    maxBudget: budget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "niomi",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => db.tasks.push(task));
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent };
}

test("signed principal mode rejects forged tenant headers", async () => {
  const secret = "principal-test-secret";
  const token = issuePrincipalToken({ tenantId: "signed-tenant", userId: "signed-user", ttlMs: 60_000 }, secret);

  process.env.RAZEKIT_REQUIRE_SIGNED_PRINCIPAL = "true";
  process.env.RAZEKIT_PRINCIPAL_SECRET = secret;

  assert.deepEqual(
    principalFromHeaders({ "x-razekit-principal": token, "x-razekit-tenant-id": "forged-tenant" }),
    { tenantId: "signed-tenant", userId: "signed-user", requestId: assert.any ? undefined : undefined }
  );
});

test("task access is tenant and user scoped", async () => {
  const { task } = await makeTask({ tenantId: "tenant-isolation", userId: "owner" });
  await assert.doesNotReject(() => assertTaskAccess(task.id, { tenantId: "tenant-isolation", userId: "owner" }));
  await assert.rejects(
    () => assertTaskAccess(task.id, { tenantId: "tenant-other", userId: "owner" }),
    /Tenant access denied/
  );
  await assert.rejects(
    () => assertTaskAccess(task.id, { tenantId: "tenant-isolation", userId: "other" }),
    /User access denied/
  );
});

test("suspended tenants are fail-closed for task access", async () => {
  const { task } = await makeTask({ tenantId: "tenant-suspended" });
  await suspendTenant("tenant-suspended");
  assert.throws(() => assertTenantActive({ status: "suspended" }), /Tenant is suspended/);
  await assert.rejects(
    () => assertTaskAccess(task.id, { tenantId: "tenant-suspended", userId: "user-a" }),
    /Tenant is suspended/
  );
  await resumeTenant("tenant-suspended");
});

test("audit logging redacts secret-bearing fields", async () => {
  const event = await writeAudit({
    tenantId: "tenant-a",
    userId: "user-a",
    action: "credential.test",
    resourceType: "credential",
    metadata: {
      provider: "demo",
      apiKey: "do-not-store",
      nested: { password: "also-secret", visible: "ok" }
    }
  });
  assert.equal(event.metadata.apiKey, "[redacted]");
  assert.equal(event.metadata.nested.password, "[redacted]");
  assert.equal(event.metadata.nested.visible, "ok");

  const db = await loadDb();
  const saved = db.auditLogs.find(item => item.id === event.id);
  assert.equal(saved.metadata.apiKey, "[redacted]");
});

test("temporary credentials are scoped and expire or revoke", async () => {
  const { agent } = await makeTask();
  const credential = await registerCredentialReference(agent.id, {
    provider: "razorpay",
    kind: "api",
    scopes: ["payments:read", "payments:write"],
    secret: "never-persist-this-secret"
  });

  const db = await loadDb();
  assert.equal("secret" in db.credentials.find(item => item.id === credential.id), false);

  const lease = await issueTemporaryCredential(agent.id, credential.id, {
    scopes: ["payments:read"],
    ttlMs: 60_000
  });
  assert.deepEqual(lease.scopes, ["payments:read"]);
  assert.equal(await validateTemporaryCredential(agent.id, lease.id, ["payments:read"]) !== null, true);
  assert.equal(await validateTemporaryCredential(agent.id, lease.id, ["payments:write"]), null);

  await revokeTemporaryCredential(lease.id);
  assert.equal(await validateTemporaryCredential(agent.id, lease.id, ["payments:read"]), null);
  assert.equal((await listCredentialLeases(agent.id)).find(item => item.id === lease.id).status, "revoked");

  await assert.rejects(
    () => issueTemporaryCredential(agent.id, credential.id, { scopes: ["payments:admin"] }),
    /exceeds granted/
  );
});

test("budget reservations prevent concurrent over-commitment", async () => {
  const { agent } = await makeTask({ budget: 10 });
  const first = await reserveSpend(agent.id, 6, "first", {
    idempotencyKey: "reservation-1",
    category: "model"
  });
  assert.equal(first.status, "reserved");

  await assert.rejects(
    () => reserveSpend(agent.id, 5, "second", {
      idempotencyKey: "reservation-2",
      category: "model"
    }),
    /Hard budget limit exceeded/
  );

  await captureSpend(first.id);
  const after = await loadDb();
  const current = after.agentInstances.find(item => item.id === agent.id);
  assert.equal(current.budgetUsed, 6);

  const second = await reserveSpend(agent.id, 4, "second", {
    idempotencyKey: "reservation-2",
    category: "model"
  });
  await releaseSpend(second.id);
});

test("provider billing is idempotent and ledgered", async () => {
  billingRegistry.register("deterministic", new DeterministicBillingAdapter());
  const { agent } = await makeTask({ budget: 20 });

  const first = await chargeProvider({
    agentId: agent.id,
    amount: 3,
    reason: "provider work",
    provider: "deterministic",
    idempotencyKey: "charge-1"
  });
  const replay = await chargeProvider({
    agentId: agent.id,
    amount: 3,
    reason: "provider work",
    provider: "deterministic",
    idempotencyKey: "charge-1"
  });

  assert.equal(first.capture.status, "captured");
  assert.equal(replay.idempotentReplay, true);

  const db = await loadDb();
  const ledger = db.billingLedger.filter(item => item.idempotencyKey === "charge-1");
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amount, 3);
});

test("tenant abuse limits block excessive commands", async () => {
  await ensureTenant("tenant-abuse");
  await setTenantLimits("tenant-abuse", { commandsPerMinute: 1 });
  await writeAudit({
    tenantId: "tenant-abuse",
    userId: "user-a",
    action: "task.command",
    resourceType: "task",
    resourceId: "task-1"
  });

  await assert.rejects(
    () => enforceTenantLimit("tenant-abuse", "commandsPerMinute", "task.command"),
    /Abuse limit exceeded/
  );
});

test("active task limits are enforced", async () => {
  await ensureTenant("tenant-active-limit");
  await setTenantLimits("tenant-active-limit", { maxActiveTasks: 1 });
  await transact(db => db.tasks.push({
    id: id("task"),
    tenantId: "tenant-active-limit",
    userId: "user-a",
    taskType: "website",
    title: "active",
    originalRequest: "active",
    specification: "active",
    status: TASK_STATUS.RUNNING,
    maxBudget: 10,
    actualSpend: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
  await assert.rejects(
    () => enforceActiveTaskLimit("tenant-active-limit", { userId: "user-a" }),
    /Abuse limit exceeded: maxActiveTasks/
  );
});

test("admin controls can suspend, resume and inspect tenant state", async () => {
  assert.throws(() => assertAdminToken("wrong"), /Admin authorization required/);
  assert.doesNotThrow(() => assertAdminToken("test-admin-token"));

  const { task, agent } = await makeTask({ tenantId: "tenant-admin" });
  const suspended = await suspendTenant("tenant-admin");
  assert.equal(suspended.tenant.status, "suspended");

  let db = await loadDb();
  assert.equal(db.tasks.find(item => item.id === task.id).status, TASK_STATUS.PAUSED);
  assert.equal(db.agentInstances.find(item => item.id === agent.id).status, AGENT_STATUS.BLOCKED);

  await resumeTenant("tenant-admin");
  db = await loadDb();
  assert.equal(db.tasks.find(item => item.id === task.id).status, TASK_STATUS.RUNNING);
  assert.equal(db.agentInstances.find(item => item.id === agent.id).status, AGENT_STATUS.RUNNING);

  await updateTenantLimits("tenant-admin", { toolCallsPerMinute: 9 });
  const summary = await tenantSecuritySummary("tenant-admin");
  assert.equal(summary.tenant.limits.toolCallsPerMinute, 9);
  assert.equal(summary.taskCount, 1);

  const audit = await queryAudit({ tenantId: "tenant-admin" });
  assert.ok(audit.some(item => item.action === "tenant.suspend"));
  assert.ok(audit.some(item => item.action === "tenant.resume"));
  assert.ok(audit.some(item => item.action === "tenant.limits.update"));
});

test("secret vault abstraction keeps raw secret storage outside the database contract", async () => {
  const registry = new SecretVaultRegistry();
  const vault = new InMemorySecretVault();
  registry.configure(vault);
  await vault.put("vaultref_test", "raw-secret");
  assert.equal(await registry.get().get("vaultref_test"), "raw-secret");

  const referenceOnly = new SecretVaultRegistry();
  referenceOnly.configure({
    put: async () => { throw new Error("raw secret storage disabled"); },
    get: async () => null,
    revoke: async () => ({ revoked: true })
  });
  assert.equal(await referenceOnly.get().get("vaultref_any"), null);
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
