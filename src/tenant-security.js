import { id, loadDb, transact } from "./store.js";
import { AUTH_MODES, AuthError, ROLES, authMode, resolveSession, sessionTokenFromRequest } from "./auth.js";

export const DEFAULT_TENANT_ID = "local-tenant";
export const DEFAULT_USER_ID = "local-user";

const REDACT_KEYS = /secret|token|password|authorization|api[-_]?key|credential/i;

/**
 * Who is calling. In session mode this is the signed-in DEV account behind the
 * session cookie (or bearer token); a missing or expired session is a 401. In
 * local mode (development and tests only — refused in production) it is
 * whatever the x-razekit-tenant-id / x-razekit-user-id headers say.
 *
 * There is no third path: DEV no longer accepts a principal signed by the
 * RazeKit marketplace.
 */
export async function resolvePrincipal(headers = {}) {
  const requestId = String(headers["x-razekit-request-id"] || id("req"));

  if (authMode() === AUTH_MODES.LOCAL) {
    return {
      tenantId: String(headers["x-razekit-tenant-id"] || DEFAULT_TENANT_ID),
      userId: String(headers["x-razekit-user-id"] || DEFAULT_USER_ID),
      role: ROLES.MEMBER,
      authenticated: false,
      requestId
    };
  }

  const resolved = await resolveSession(sessionTokenFromRequest(headers));
  if (!resolved) throw new AuthError(401, "Sign in required");
  return {
    tenantId: resolved.user.tenantId,
    userId: resolved.user.id,
    email: resolved.user.email,
    role: resolved.user.role,
    sessionId: resolved.sessionId,
    authenticated: true,
    requestId
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
