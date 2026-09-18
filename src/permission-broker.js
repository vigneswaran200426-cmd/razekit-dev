import { id, loadDb, transact } from "./store.js";
import { getAgent } from "./agent-manager.js";
import { getTool, requiredScopesForTools } from "./tool-registry.js";
import { AGENT_STATUS, TASK_STATUS } from "./domain.js";

const APPROVAL_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  DENIED: "denied",
  EXPIRED: "expired"
};

function scopeSet(scopes = []) {
  return new Set(scopes.filter(Boolean));
}

function isExpired(value) {
  return value ? Date.parse(value) <= Date.now() : false;
}

async function updateWaitingState(agentInstanceId, blocked) {
  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");

    const task = db.tasks.find(x => x.id === agent.taskId);
    if (blocked) {
      agent.status = AGENT_STATUS.WAITING_USER;
      agent.executionState = "waiting_user";
      if (task) {
        task.status = TASK_STATUS.WAITING_USER;
        task.updatedAt = new Date().toISOString();
      }
    } else {
      if (agent.status === AGENT_STATUS.WAITING_USER) agent.status = AGENT_STATUS.RUNNING;
      if (agent.executionState === "waiting_user") agent.executionState = "running";
      if (task?.status === TASK_STATUS.WAITING_USER) {
        task.status = TASK_STATUS.RUNNING;
        task.updatedAt = new Date().toISOString();
      }
    }

    return agent;
  });
}

export async function provisionPermissions(agent) {
  const toolKeys = agent.toolConfig?.manifest
    ?.filter(tool => tool.enabled)
    .map(tool => tool.key) || [];

  const requiredScopes = requiredScopesForTools(toolKeys);

  return transact(db => {
    const existing = db.toolPermissions.find(x => x.agentInstanceId === agent.id);
    const now = new Date().toISOString();

    if (existing) {
      existing.requiredScopes = requiredScopes;
      existing.updatedAt = now;
      return existing;
    }

    const task = db.tasks.find(x => x.id === agent.taskId);
    const preauthorized = new Set(task?.authorization?.toolScopes || []);
    const grantedScopes = requiredScopes.filter(scope => preauthorized.has(scope));

    const permission = {
      id: id("perm"),
      agentInstanceId: agent.id,
      taskId: agent.taskId,
      requiredScopes,
      grantedScopes: [...new Set(grantedScopes)],
      createdAt: now,
      updatedAt: now
    };

    db.toolPermissions.push(permission);
    return permission;
  });
}

export async function authorizeToolCall(agentInstanceId, toolKey, scopes = []) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  const tool = getTool(toolKey);
  const enabled = new Set(
    agent.toolConfig?.manifest
      ?.filter(item => item.enabled)
      .map(item => item.key) || []
  );

  if (!enabled.has(toolKey)) {
    throw new Error("Tool is not enabled for this agent instance: " + toolKey);
  }

  const requested = scopes.length ? [...new Set(scopes)] : [...tool.scopes];
  for (const scope of requested) {
    if (!tool.scopes.includes(scope)) {
      throw new Error("Scope " + scope + " is not valid for tool " + toolKey);
    }
  }

  let permission = await provisionPermissions(agent);
  const granted = scopeSet(permission.grantedScopes);
  const missing = requested.filter(scope => !granted.has(scope));

  if (missing.length === 0) {
    return {
      allowed: true,
      tool,
      requestedScopes: requested,
      grantedScopes: requested,
      permissionRequest: null
    };
  }

  const request = await transact(db => {
    const active = db.permissionRequests.find(x =>
      x.agentInstanceId === agentInstanceId &&
      x.toolKey === toolKey &&
      x.status === APPROVAL_STATUS.PENDING &&
      x.scopes.join("|") === missing.join("|")
    );

    if (active) return active;

    const now = new Date().toISOString();
    const item = {
      id: id("preq"),
      agentInstanceId,
      taskId: agent.taskId,
      toolKey,
      scopes: missing,
      reason: "New tool permission required",
      status: APPROVAL_STATUS.PENDING,
      createdAt: now,
      updatedAt: now,
      expiresAt: null
    };

    db.permissionRequests.push(item);
    return item;
  });

  await updateWaitingState(agentInstanceId, true);

  return {
    allowed: false,
    tool,
    requestedScopes: requested,
    grantedScopes: permission.grantedScopes,
    missingScopes: missing,
    permissionRequest: request
  };
}

export async function approvePermission(permissionRequestId, expiresAt = null) {
  const request = await transact(db => {
    const item = db.permissionRequests.find(x => x.id === permissionRequestId);
    if (!item) throw new Error("Permission request not found");
    if (item.status !== APPROVAL_STATUS.PENDING) {
      throw new Error("Permission request is not pending");
    }
    if (expiresAt && isExpired(expiresAt)) throw new Error("expiresAt must be in the future");

    item.status = APPROVAL_STATUS.APPROVED;
    item.expiresAt = expiresAt;
    item.updatedAt = new Date().toISOString();

    const permission = db.toolPermissions.find(x => x.agentInstanceId === item.agentInstanceId);
    if (!permission) throw new Error("Tool permission record not found");

    permission.grantedScopes = [...new Set([...permission.grantedScopes, ...item.scopes])];
    permission.updatedAt = item.updatedAt;
    return item;
  });

  const pending = await listPendingRequests(request.agentInstanceId);
  await updateWaitingState(request.agentInstanceId, pending.length > 0);

  return request;
}

export async function denyPermission(permissionRequestId, reason = "Permission denied by user") {
  const request = await transact(db => {
    const item = db.permissionRequests.find(x => x.id === permissionRequestId);
    if (!item) throw new Error("Permission request not found");
    if (item.status !== APPROVAL_STATUS.PENDING) {
      throw new Error("Permission request is not pending");
    }

    item.status = APPROVAL_STATUS.DENIED;
    item.reason = reason;
    item.updatedAt = new Date().toISOString();
    return item;
  });

  const pending = await listPendingRequests(request.agentInstanceId);
  await updateWaitingState(request.agentInstanceId, pending.length > 0);
  return request;
}

export async function listPendingRequests(agentInstanceId) {
  const db = await loadDb();
  return db.permissionRequests.filter(x =>
    x.agentInstanceId === agentInstanceId &&
    x.status === APPROVAL_STATUS.PENDING &&
    !isExpired(x.expiresAt)
  );
}

export async function getPermissions(agentInstanceId) {
  const db = await loadDb();
  return db.toolPermissions.find(x => x.agentInstanceId === agentInstanceId) || null;
}

export async function getAuthorizationPlan(agentInstanceId) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");

  const permissions = await provisionPermissions(agent);
  const requests = await listPendingRequests(agentInstanceId);

  return {
    agentInstanceId,
    taskId: agent.taskId,
    requiredScopes: permissions.requiredScopes,
    grantedScopes: permissions.grantedScopes,
    pendingRequests: requests
  };
}
