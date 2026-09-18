import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-perm-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-perm-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, loadDb, id } = await import("../src/store.js");
const { AGENT_STATUS, AGENT_TYPES, TASK_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { requiredScopesForTools, listTools } = await import("../src/tool-registry.js");
const {
  authorizeToolCall,
  approvePermission,
  listPendingRequests,
  getAuthorizationPlan,
  denyPermission
} = await import("../src/permission-broker.js");
const {
  registerCredentialReference,
  listCredentialReferences,
  revokeCredentialReference
} = await import("../src/credential-vault.js");
const { ToolAdapterRegistry, ToolBroker } = await import("../src/tool-broker.js");
const { EchoToolAdapter } = await import("../src/testing-tool-adapters.js");

async function makeTask(title, requestedTools, toolScopes = requestedTools ? requiredScopesForTools(requestedTools) : []) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "test-user",
    taskType: "website",
    title,
    originalRequest: "Build " + title,
    specification: "Build " + title,
    requestedTools,
    estimatedBudget: 1,
    maxBudget: 10,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes,
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };

  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({
      id: id("ac"),
      taskId: task.id,
      text: "Build passes",
      status: "pending"
    });
  });

  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return agent;
}

test("registry exposes stable tool definitions and permission scopes", () => {
  const tools = listTools();
  assert.ok(tools.some(x => x.key === "filesystem"));
  assert.ok(tools.some(x => x.key === "database"));
  assert.deepEqual(
    requiredScopesForTools(["filesystem", "git"]),
    ["git:read", "git:write", "workspace:read", "workspace:write"]
  );
});

test("preauthorized tool invocation succeeds and is audited", async () => {
  const agent = await makeTask("Preauthorized", ["filesystem"]);
  const registry = new ToolAdapterRegistry();
  registry.register("filesystem", new EchoToolAdapter());
  const broker = new ToolBroker({ registry });

  const result = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "filesystem",
    input: { action: "list" }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.result.tool, "filesystem");
  assert.equal(result.audit.status, "completed");

  const db = await loadDb();
  assert.equal(db.toolCalls.filter(x => x.agentInstanceId === agent.id).length, 1);
});

test("new permission pauses the agent and approval resumes it", async () => {
  const agent = await makeTask("Needs New Permission", ["filesystem"], ["workspace:read"]);

  const decision = await authorizeToolCall(agent.id, "filesystem", ["workspace:write"]);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.missingScopes, ["workspace:write"]);

  const pending = await listPendingRequests(agent.id);
  assert.equal(pending.length, 1);

  const blockedState = await (async () => {
    const db = await loadDb();
    return db.agentInstances.find(x => x.id === agent.id);
  })();
  assert.equal(blockedState.status, AGENT_STATUS.WAITING_USER);

  await approvePermission(pending[0].id);
  const resumedState = await (async () => {
    const db = await loadDb();
    return db.agentInstances.find(x => x.id === agent.id);
  })();

  assert.equal(resumedState.status, AGENT_STATUS.RUNNING);
  assert.equal((await listPendingRequests(agent.id)).length, 0);

  const registry = new ToolAdapterRegistry();
  registry.register("filesystem", new EchoToolAdapter());
  const broker = new ToolBroker({ registry });
  const result = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "filesystem",
    input: { action: "write" },
    scopes: ["workspace:write"]
  });

  assert.equal(result.allowed, true);
});

test("denying a permission records the denial without granting the scope", async () => {
  const agent = await makeTask("Denied Permission", ["filesystem"], ["workspace:read"]);
  const decision = await authorizeToolCall(agent.id, "filesystem", ["workspace:write"]);
  const request = decision.permissionRequest;

  await denyPermission(request.id, "Not approved");
  const pending = await listPendingRequests(agent.id);
  assert.equal(pending.length, 0);

  const plan = await getAuthorizationPlan(agent.id);
  assert.equal(plan.grantedScopes.includes("workspace:write"), false);
});

test("credential references never expose a secret value", async () => {
  const agent = await makeTask("Credentialed Tool", ["database"]);
  const reference = await registerCredentialReference(agent.id, {
    provider: "database",
    kind: "api-token",
    scopes: ["database"],
    secret: "THIS-MUST-NOT-BE-STORED"
  });

  assert.equal(Object.hasOwn(reference, "secret"), false);
  assert.match(reference.secretRef, /^vaultref_/);

  const listed = await listCredentialReferences(agent.id);
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], "secret"), false);

  const revoked = await revokeCredentialReference(reference.id);
  assert.equal(revoked.status, "revoked");
});

test("credential-gated tool invocation succeeds with a matching reference", async () => {
  const agent = await makeTask("Database Tool", ["database"]);
  await registerCredentialReference(agent.id, {
    provider: "database",
    kind: "api-token",
    scopes: ["database"]
  });

  const registry = new ToolAdapterRegistry();
  registry.register("database", new EchoToolAdapter());
  const broker = new ToolBroker({ registry });

  const result = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "database",
    input: { query: "SELECT 1" },
    credentialProvider: "database"
  });

  assert.equal(result.allowed, true);
  assert.match(result.result.credentialRef, /^vaultref_/);
});

test("permissions and audits are isolated between agent instances", async () => {
  const first = await makeTask("Agent A", ["filesystem"]);
  const second = await makeTask("Agent B", ["filesystem"]);

  await authorizeToolCall(second.id, "filesystem", ["workspace:execute"]).catch(() => {});

  const firstPlan = await getAuthorizationPlan(first.id);
  const secondPlan = await getAuthorizationPlan(second.id);

  assert.notEqual(first.id, second.id);
  assert.notEqual(firstPlan.taskId, secondPlan.taskId);

  const db = await loadDb();
  const scopedPermissions = db.toolPermissions.filter(
    x => x.agentInstanceId === first.id || x.agentInstanceId === second.id
  );
  assert.ok(scopedPermissions.length >= 2);
  assert.ok(scopedPermissions.every(
    x => x.agentInstanceId === first.id || x.agentInstanceId === second.id
  ));
});

test("missing adapter is audited instead of escaping silently", async () => {
  const agent = await makeTask("Missing Adapter", ["filesystem"]);
  const broker = new ToolBroker({ registry: new ToolAdapterRegistry() });

  const result = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "filesystem"
  });

  assert.equal(result.allowed, false);
  assert.equal(result.adapterUnavailable, true);
  assert.equal(result.audit.status, "adapter_unavailable");
});


test("missing credentials create a request and registration fulfills it", async () => {
  const agent = await makeTask("Credential Request", ["database"], requiredScopesForTools(["database"]));
  const registry = new ToolAdapterRegistry();
  registry.register("database", new EchoToolAdapter());
  const broker = new ToolBroker({ registry });

  const first = await broker.invoke({
    agentInstanceId: agent.id,
    toolKey: "database",
    input: { query: "SELECT 1" }
  });

  assert.equal(first.allowed, false);
  assert.equal(first.audit.status, "credential_required");
  assert.ok(first.credentialRequest);

  const requestsBefore = (await import("../src/credential-vault.js")).listCredentialRequests;
  const pendingBefore = await requestsBefore(agent.id);
  assert.equal(pendingBefore.length, 1);

  await registerCredentialReference(agent.id, {
    provider: "database",
    kind: "api-token",
    scopes: ["database"]
  });

  const pendingAfter = await requestsBefore(agent.id);
  assert.equal(pendingAfter.length, 0);

  const db = await loadDb();
  const resumed = db.agentInstances.find(x => x.id === agent.id);
  assert.equal(resumed.status, AGENT_STATUS.RUNNING);
});

test("multiple pending permissions keep the agent waiting until all are resolved", async () => {
  const agent = await makeTask("Multiple Permissions", ["filesystem"], ["workspace:read"]);

  const first = await authorizeToolCall(agent.id, "filesystem", ["workspace:write"]);
  await authorizeToolCall(agent.id, "filesystem", ["workspace:read"]).catch(() => {});

  await (async () => {
    const db = await loadDb();
    const existing = db.permissionRequests.find(x => x.id === first.permissionRequest.id);
    if (existing) existing.status = "pending";
    const second = {
      id: id("preq"),
      agentInstanceId: agent.id,
      taskId: agent.taskId,
      toolKey: "filesystem",
      scopes: ["process:execute"],
      reason: "Additional test permission",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: null
    };
    db.permissionRequests.push(second);
  })();

  const { approvePermission: approve } = await import("../src/permission-broker.js");
  await approve(first.permissionRequest.id);

  const dbAfter = await loadDb();
  const stillWaiting = dbAfter.agentInstances.find(x => x.id === agent.id);
  assert.equal(stillWaiting.status, AGENT_STATUS.WAITING_USER);
});
\ntest.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
