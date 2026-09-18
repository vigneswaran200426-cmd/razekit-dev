import { id, loadDb, transact } from "./store.js";

export const DEFAULT_TENANT_ID = "local-tenant";
export const DEFAULT_USER_ID = "local-user";

const REDACT_KEYS = /secret|token|password|authorization|api[-_]?key|credential/i;

export function principalFromHeaders(headers = {}) {
  return {
    tenantId: String(headers["x-razekit-tenant-id"] || DEFAULT_TENANT_ID),
    userId: String(headers["x-razekit-user-id"] || DEFAULT_USER_ID),
    requestId: String(headers["x-razekit-request-id"] || id("req"))
  };
}

export async function ensureTenant(tenantId = DEFAULT_TENANT_ID) {
  return transact(db => {
    let tenant = db.tenants.find(item => item.id === tenantId);
    if (!tenant) {
      const now = new Date().toISOString();
      tenant = {
        id: tenantId,
        status: "active",
        limits: {
          maxActiveTasks: 5,
          commandsPerMinute: 30,
          toolCallsPerMinute: 120,
          spendPerHour: 100
        },
        createdAt: now,
        updatedAt: now
      };
      db.tenants.push(tenant);
    }
    return tenant;
  });
}

export function assertTenantActive(tenant) {
  if (!tenant) throw new Error("Tenant not found");
  if (tenant.status !== "active") throw new Error("Tenant is suspended");
}

export async function assertTaskAccess(taskId, principal, { allowAdmin = false } = {}) {
  const db = await loadDb();
  const task = db.tasks.find(item => item.id === taskId);
  if (!task) throw new Error("Task not found");

  const tenantId = task.tenantId || DEFAULT_TENANT_ID;
  if (!allowAdmin && tenantId !== principal.tenantId) {
    throw new Error("Tenant access denied");
  }
  const tenant = db.tenants.find(item => item.id === tenantId);
  if (!allowAdmin && tenant && tenant.status !== "active") {
    throw new Error("Tenant is suspended");
  }
  if (!allowAdmin && task.userId && task.userId !== principal.userId) {
    throw new Error("User access denied");
  }
  return task;
}

export async function tenantForTask(taskId) {
  const db = await loadDb();
  const task = db.tasks.find(item => item.id === taskId);
  return task?.tenantId || DEFAULT_TENANT_ID;
}

export function redactAuditValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.map(item => redactAuditValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = REDACT_KEYS.test(key) ? "[redacted]" : redactAuditValue(child, depth + 1);
  }
  return output;
}

export async function writeAudit({
  tenantId = DEFAULT_TENANT_ID,
  userId = DEFAULT_USER_ID,
  requestId = null,
  action,
  resourceType,
  resourceId = null,
  outcome = "success",
  metadata = {}
}) {
  return transact(db => {
    const entry = {
      id: id("audit"),
      tenantId,
      userId,
      requestId,
      action,
      resourceType,
      resourceId,
      outcome,
      metadata: redactAuditValue(metadata),
      createdAt: new Date().toISOString()
    };
    db.auditLogs.push(entry);
    return entry;
  });
}
