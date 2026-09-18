import { loadDb, transact } from "./store.js";
import { AGENT_STATUS, TASK_STATUS } from "./domain.js";
import { ensureTenant, writeAudit } from "./tenant-security.js";
import { setTenantLimits } from "./abuse-controls.js";
import { revokeCredentialReference } from "./credential-vault.js";
import { cancelAgent } from "./agent-manager.js";

function validAdminToken(token) {
  const expected = process.env.RAZEKIT_ADMIN_TOKEN;
  return Boolean(expected && token && token === expected);
}

export function assertAdminToken(token) {
  if (!validAdminToken(token)) throw new Error("Admin authorization required");
}

export async function tenantSecuritySummary(tenantId) {
  const tenant = await ensureTenant(tenantId);
  const db = await loadDb();
  const tasks = db.tasks.filter(task => (task.tenantId || "local-tenant") === tenantId);
  const agents = db.agentInstances.filter(agent => {
    const task = tasks.find(item => item.id === agent.taskId);
    return Boolean(task);
  });
  return {
    tenant,
    taskCount: tasks.length,
    activeTaskCount: tasks.filter(task => ["queued", "running", "waiting_user", "ready_for_agent"].includes(task.status)).length,
    agentCount: agents.length,
    credentialCount: db.credentials.filter(item => item.taskId && tasks.some(task => task.id === item.taskId)).length,
    spend: db.billingLedger
      .filter(item => item.tenantId === tenantId)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0)
  };
}

export async function suspendTenant(tenantId, actor = "admin") {
  const result = await transact(db => {
    const tenant = db.tenants.find(item => item.id === tenantId);
    if (!tenant) throw new Error("Tenant not found");
    tenant.status = "suspended";
    tenant.updatedAt = new Date().toISOString();
    for (const task of db.tasks.filter(item => (item.tenantId || "local-tenant") === tenantId)) {
      if ([TASK_STATUS.RUNNING, TASK_STATUS.QUEUED, TASK_STATUS.WAITING_USER].includes(task.status)) {
        task.status = TASK_STATUS.PAUSED;
        task.pausedReason = "tenant_suspended";
        task.updatedAt = tenant.updatedAt;
      }
    }
    for (const agent of db.agentInstances) {
      const task = db.tasks.find(item => item.id === agent.taskId);
      if (task && (task.tenantId || "local-tenant") === tenantId &&
          [AGENT_STATUS.RUNNING, AGENT_STATUS.WAITING_USER].includes(agent.status)) {
        agent.status = AGENT_STATUS.BLOCKED;
        agent.executionState = "blocked";
        agent.blockedReason = "tenant_suspended";
      }
    }
    const action = {
      id: "admin_" + tenant.updatedAt,
      tenantId,
      actor,
      action: "tenant.suspend",
      createdAt: tenant.updatedAt
    };
    db.adminActions.push(action);
    return { tenant, action };
  });
  await writeAudit({
    tenantId,
    userId: actor,
    action: "tenant.suspend",
    resourceType: "tenant",
    resourceId: tenantId
  });
  return result;
}

export async function resumeTenant(tenantId, actor = "admin") {
  const result = await transact(db => {
    const tenant = db.tenants.find(item => item.id === tenantId);
    if (!tenant) throw new Error("Tenant not found");
    tenant.status = "active";
    tenant.updatedAt = new Date().toISOString();

    for (const task of db.tasks.filter(item =>
      (item.tenantId || "local-tenant") === tenantId &&
      item.status === TASK_STATUS.PAUSED &&
      item.pausedReason === "tenant_suspended"
    )) {
      task.status = TASK_STATUS.RUNNING;
      task.pausedReason = null;
      task.updatedAt = tenant.updatedAt;
    }
    for (const agent of db.agentInstances) {
      const task = db.tasks.find(item => item.id === agent.taskId);
      if (task && (task.tenantId || "local-tenant") === tenantId && agent.status === AGENT_STATUS.BLOCKED) {
        agent.status = AGENT_STATUS.RUNNING;
        agent.executionState = "running";
      }
    }

    const action = {
      id: "admin_" + tenant.updatedAt,
      tenantId,
      actor,
      action: "tenant.resume",
      createdAt: tenant.updatedAt
    };
    db.adminActions.push(action);
    return { tenant, action };
  });
  await writeAudit({
    tenantId,
    userId: actor,
    action: "tenant.resume",
    resourceType: "tenant",
    resourceId: tenantId
  });
  return result;
}

export async function updateTenantLimits(tenantId, limits, actor = "admin") {
  const result = await setTenantLimits(tenantId, limits);
  await writeAudit({
    tenantId,
    userId: actor,
    action: "tenant.limits.update",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { limits }
  });
  return result;
}

export async function adminRevokeCredential(credentialId, actor = "admin") {
  const credential = await revokeCredentialReference(credentialId);
  await writeAudit({
    tenantId: "unknown",
    userId: actor,
    action: "credential.revoke",
    resourceType: "credential",
    resourceId: credentialId
  });
  return credential;
}

export async function cancelTenantTasks(tenantId, actor = "admin") {
  const db = await loadDb();
  const tasks = db.tasks.filter(task => (task.tenantId || "local-tenant") === tenantId);
  const cancelled = [];
  for (const task of tasks) {
    const agent = task.agentInstanceId ? db.agentInstances.find(item => item.id === task.agentInstanceId) : null;
    if (agent && [AGENT_STATUS.RUNNING, AGENT_STATUS.WAITING_USER, AGENT_STATUS.BLOCKED].includes(agent.status)) {
      cancelled.push(await cancelAgent(agent.id, "Cancelled by administrator"));
    }
  }
  await writeAudit({
    tenantId,
    userId: actor,
    action: "tenant.tasks.cancel_all",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { cancelledCount: cancelled.length }
  });
  return cancelled;
}

export async function queryAudit({ tenantId, action = null, limit = 100 } = {}) {
  const db = await loadDb();
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  return db.auditLogs
    .filter(item => !tenantId || item.tenantId === tenantId)
    .filter(item => !action || item.action === action)
    .slice(-max)
    .reverse();
}
