import { loadDb } from "./store.js";
import { getAgent, resumeAgent } from "./agent-manager.js";
import { APPROVAL_SCOPE, approvePermission, denyPermission } from "./permission-broker.js";
import { reopenNode } from "./jev.js";
import { writeAudit } from "./tenant-security.js";
import { pendingReconciliations } from "./model-reconciliation.js";

// Everything a task is waiting on a person for, in one place.
//
// The requests themselves already existed — a permission request here, a
// credential request there, a change request in the dashboard, a budget block
// recorded on the blackboard. What did not exist was anywhere to see them
// together, so the answer to "why has this task not moved for an hour" was
// "read the logs". A task that is waiting and cannot say so is indistinguishable
// from a task that is stuck.
//
// This adds no new store of requests. It is a projection over the records that
// already decide things, plus one place to answer them — because a second
// source of truth for "is this approved" would eventually disagree with the
// first, and the disagreement would be a security bug rather than a display bug.

export const USER_ACTION_KIND = {
  PERMISSION: "permission",
  CREDENTIAL: "credential",
  APPROVAL: "approval",
  BUDGET: "budget",
  RECONCILIATION: "reconciliation",
  DECISION: "decision"
};

export const USER_ACTION_URGENCY = {
  // Blocking: the task cannot continue at all until this is answered.
  BLOCKING: "blocking",
  // The task continues; this shapes what it does next.
  ADVISORY: "advisory"
};

/**
 * Everything waiting on the user for one task.
 *
 * Ordered blocking-first, because the list exists to answer "what do I have to
 * do for this to move" and an advisory item above a blocking one buries the
 * answer.
 */
export async function pendingUserActions({ taskId = null, agentInstanceId = null, tenantId = null } = {}) {
  const db = await loadDb();

  const matchesTask = record => {
    if (taskId && record.taskId !== taskId) return false;
    if (agentInstanceId && record.agentInstanceId !== agentInstanceId) return false;
    return true;
  };

  const tenantOf = id => db.tasks.find(task => task.id === id)?.tenantId ?? null;
  const inTenant = record => !tenantId || tenantOf(record.taskId) === tenantId;
  const notExpired = record => !record.expiresAt || Date.parse(record.expiresAt) > Date.now();

  const actions = [];

  for (const request of db.permissionRequests) {
    if (request.status !== "pending" || !matchesTask(request) || !inTenant(request) || !notExpired(request)) continue;
    actions.push({
      id: request.id,
      kind: USER_ACTION_KIND.PERMISSION,
      urgency: USER_ACTION_URGENCY.BLOCKING,
      taskId: request.taskId,
      agentInstanceId: request.agentInstanceId,
      nodeId: request.nodeId ?? null,
      title: "Permission needed: " + request.toolKey,
      detail: "The task needs " + request.scopes.join(", ") + " to continue.",
      // Offered every time, narrowest first, so the quick path is the safe one.
      choices: [
        { value: APPROVAL_SCOPE.ONCE, label: "Allow once" },
        { value: APPROVAL_SCOPE.NODE, label: "Allow for this step" },
        { value: APPROVAL_SCOPE.TASK, label: "Allow for this whole task" }
      ],
      scopes: request.scopes,
      createdAt: request.createdAt
    });
  }

  for (const request of db.credentialRequests) {
    if (request.status !== "pending" || !matchesTask(request) || !inTenant(request)) continue;
    actions.push({
      id: request.id,
      kind: USER_ACTION_KIND.CREDENTIAL,
      urgency: USER_ACTION_URGENCY.BLOCKING,
      taskId: request.taskId,
      agentInstanceId: request.agentInstanceId,
      title: "Credential needed: " + (request.provider || "external service"),
      // The value itself is never routed through here, and never logged.
      detail: "The task needs access to " + (request.provider || "an external service") +
        ". Supply it through the credential vault; it is not entered here.",
      scopes: request.scopes || [],
      createdAt: request.createdAt
    });
  }

  for (const change of db.taskChangeRequests) {
    if (change.status !== "pending" || !matchesTask(change) || !inTenant(change)) continue;
    actions.push({
      id: change.id,
      kind: USER_ACTION_KIND.DECISION,
      // A change request does not stop the task; it asks whether to alter it.
      urgency: USER_ACTION_URGENCY.ADVISORY,
      taskId: change.taskId,
      agentInstanceId: change.agentInstanceId ?? null,
      title: "Change requested",
      detail: change.reason || change.content || "A change to this task is waiting for your decision.",
      createdAt: change.createdAt
    });
  }

  for (const record of await pendingReconciliations({ agentInstanceId, tenantId })) {
    if (taskId && record.taskId !== taskId) continue;
    actions.push({
      id: record.id,
      kind: USER_ACTION_KIND.RECONCILIATION,
      urgency: USER_ACTION_URGENCY.BLOCKING,
      taskId: record.taskId,
      agentInstanceId: record.agentInstanceId,
      nodeId: record.nodeId,
      title: "A model call's outcome is unknown",
      detail: "The " + record.provider + " request for " + record.nodeKey +
        " was sent but never answered. It may have been completed and charged. " +
        "The task has stopped rather than repeat it.",
      createdAt: record.createdAt
    });
  }

  // A task that ran out of budget is waiting on a person just as much as one
  // waiting on an approval, and it used to say so only on the blackboard.
  for (const entry of db.agentBlackboards) {
    if (!entry.key.endsWith(".budgetRefusal")) continue;
    if (agentInstanceId && entry.agentInstanceId !== agentInstanceId) continue;
    const agent = db.agentInstances.find(item => item.id === entry.agentInstanceId);
    if (!agent) continue;
    if (taskId && agent.taskId !== taskId) continue;
    if (tenantId && tenantOf(agent.taskId) !== tenantId) continue;
    if (agent.status !== "waiting_user") continue;

    const value = typeof entry.value === "string" ? safeParse(entry.value) : entry.value;
    if (!value) continue;
    actions.push({
      id: "budget:" + agent.id,
      kind: USER_ACTION_KIND.BUDGET,
      urgency: USER_ACTION_URGENCY.BLOCKING,
      taskId: agent.taskId,
      agentInstanceId: agent.id,
      title: "More budget needed",
      detail: "The task stopped at " + (value.nodeKey || "a step") + ": " + (value.reason || "budget exhausted") + ".",
      createdAt: entry.updatedAt || entry.createdAt || new Date().toISOString()
    });
  }

  return actions.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === USER_ACTION_URGENCY.BLOCKING ? -1 : 1;
    return Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0);
  });
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Answer a permission request.
 *
 * `approve: false` is a real answer, not a failure to answer: the task learns
 * it may not do this, and stops rather than sitting in a queue forever.
 *
 * On approval the node that hit the refusal is reopened, so the task carries on
 * from where it stopped instead of having failed while waiting for the person
 * who was going to unblock it.
 */
export async function resolvePermissionAction({
  requestId,
  approve,
  scope = APPROVAL_SCOPE.ONCE,
  expiresAt = null,
  reason = null,
  actedBy = "user",
  resumeTask = true
}) {
  const db = await loadDb();
  const request = db.permissionRequests.find(item => item.id === requestId);
  if (!request) throw new Error("Permission request not found");

  const tenantId = db.tasks.find(task => task.id === request.taskId)?.tenantId ?? null;

  if (!approve) {
    const denied = await denyPermission(requestId, reason || "Permission declined");
    await writeAudit({
      tenantId,
      action: "user.permission.denied",
      resourceType: "permission_request",
      resourceId: requestId,
      outcome: "success",
      metadata: { toolKey: request.toolKey, scopes: request.scopes, actedBy }
    }).catch(() => undefined);
    return { approved: false, request: denied, reopened: null, resumed: false };
  }

  const approved = await approvePermission(requestId, { scope, expiresAt, approvedBy: actedBy });

  // The node failed when the permission was refused. Approving now makes
  // retrying it safe, and leaving it failed would mean the approval changed
  // nothing the user could see.
  let reopened = null;
  if (request.nodeId) {
    reopened = await reopenNode({
      nodeId: request.nodeId,
      reason: "permission granted by " + actedBy
    }).catch(() => null);
  }

  // The broker already returns an agent to RUNNING when nothing else is
  // pending, so this covers the case where something else was — and reports
  // whether the task is running NOW rather than whether this call is what
  // moved it. The user asked "can it continue", not "who unblocked it".
  let resumed = false;
  if (resumeTask) {
    let agent = await getAgent(request.agentInstanceId);
    if (agent && ["waiting_user", "blocked"].includes(agent.status)) {
      const others = db.permissionRequests.filter(item =>
        item.agentInstanceId === request.agentInstanceId &&
        item.id !== requestId &&
        item.status === "pending"
      );
      if (others.length === 0) {
        agent = await resumeAgent(request.agentInstanceId, "Permission granted; continuing.");
      }
    }
    resumed = agent?.status === "running";
  }

  await writeAudit({
    tenantId,
    action: "user.permission.approved",
    resourceType: "permission_request",
    resourceId: requestId,
    outcome: "success",
    metadata: {
      toolKey: request.toolKey,
      scopes: request.scopes,
      approvalScope: scope,
      actedBy,
      reopenedNode: Boolean(reopened?.accepted)
    }
  }).catch(() => undefined);

  return { approved: true, request: approved, reopened, resumed };
}
