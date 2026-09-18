import { loadDb, transact } from "./store.js";
import { ensureTenant, writeAudit } from "./tenant-security.js";

function windowStart(ms) {
  return Date.now() - ms;
}

function countRecent(auditLogs, { tenantId, action, since }) {
  return auditLogs.filter(item =>
    item.tenantId === tenantId &&
    item.action === action &&
    Date.parse(item.createdAt) >= since
  ).length;
}

export async function enforceTenantLimit(tenantId, key, action, requestContext = {}) {
  const tenant = await ensureTenant(tenantId);
  const limit = Number(tenant.limits?.[key]);
  if (!Number.isFinite(limit) || limit < 0) return;

  const db = await loadDb();
  const durations = {
    maxActiveTasks: null,
    commandsPerMinute: 60_000,
    toolCallsPerMinute: 60_000,
    spendPerHour: 3_600_000
  };
  const duration = durations[key];
  if (duration == null) return;

  const since = windowStart(duration);
  const recent = countRecent(db.auditLogs, { tenantId, action, since });
  if (recent >= limit) {
    await writeAudit({
      tenantId,
      userId: requestContext.userId,
      requestId: requestContext.requestId,
      action,
      resourceType: "abuse-limit",
      outcome: "blocked",
      metadata: { limit, key }
    });
    throw new Error("Abuse limit exceeded: " + key);
  }
}

export async function enforceActiveTaskLimit(tenantId, requestContext = {}) {
  const tenant = await ensureTenant(tenantId);
  const db = await loadDb();
  const active = db.tasks.filter(task =>
    (task.tenantId || "local-tenant") === tenantId &&
    ["ready_for_agent", "queued", "running", "waiting_user", "paused"].includes(task.status)
  ).length;
  if (active >= Number(tenant.limits?.maxActiveTasks ?? 5)) {
    await writeAudit({
      tenantId,
      userId: requestContext.userId,
      requestId: requestContext.requestId,
      action: "task.create",
      resourceType: "abuse-limit",
      outcome: "blocked",
      metadata: { active, limit: tenant.limits?.maxActiveTasks }
    });
    throw new Error("Abuse limit exceeded: maxActiveTasks");
  }
}

export async function setTenantLimits(tenantId, limits) {
  return transact(db => {
    const tenant = db.tenants.find(item => item.id === tenantId);
    if (!tenant) throw new Error("Tenant not found");
    tenant.limits = {
      ...tenant.limits,
      ...Object.fromEntries(Object.entries(limits || {}).filter(([key, value]) =>
        ["maxActiveTasks", "commandsPerMinute", "toolCallsPerMinute", "spendPerHour"].includes(key) &&
        Number.isFinite(Number(value)) &&
        Number(value) >= 0
      ))
    };
    tenant.updatedAt = new Date().toISOString();
    return tenant;
  });
}
