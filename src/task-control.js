import { loadDb } from "./store.js";
import { minorToMajor } from "./jev-budget.js";
import { taskGraphView } from "./task-graph-view.js";
import { pendingUserActions } from "./user-actions.js";
import { currentInstruction, instructionHistory } from "./task-instructions.js";
import { graphCycles } from "./jev-model-graph.js";

// The Control Center's data, in one read.
//
// The dashboard already answers "how is it going". This answers the questions
// that used to require the database: what is this task ALLOWED to do, what has
// it actually spent as opposed to reserved, what has it been asked for over
// time, and what is it waiting on.
//
// Every number here comes from a durable record. There is deliberately no
// "predicted final cost" that is a straight-line extrapolation of spend so far:
// a task's remaining cost depends on how many repair cycles it needs, which is
// not known, and a confident-looking projection of it would be a guess wearing
// a number's clothes. What is shown instead is what is reserved — money that is
// actually committed — alongside what has actually been spent.

function reservationView(reservation) {
  return {
    id: reservation.id,
    reason: reservation.reason,
    status: reservation.status,
    amount: Number(reservation.amount || 0),
    capturedAmount: reservation.capturedAmount ?? null,
    releasedAmount: reservation.releasedAmount ?? null,
    createdAt: reservation.createdAt,
    resolvedAt: reservation.resolvedAt ?? null
  };
}

/**
 * Budget, with estimate and actual kept apart.
 *
 * They are never added together and never shown as one figure. An estimate is
 * what we thought; an actual is what the ledger says. A single number that
 * silently mixes them is how a task appears to be under budget right up until
 * it is not.
 */
function budgetPanel(db, task, agent, graph) {
  const reservations = db.billingReservations
    .filter(item => item.agentInstanceId === agent?.id)
    .map(reservationView);

  const held = reservations.filter(item => item.status === "reserved");
  const spent = Number(agent?.budgetUsed || 0);
  const limit = Number(task.maxBudget || 0);

  return {
    currency: task.currency || "USD",
    limit,
    spent,
    // Committed but not yet settled. This is the part a straight "remaining"
    // figure hides, and it is the part that decides whether the next node can
    // afford to run.
    held: Number(held.reduce((sum, item) => sum + item.amount, 0).toFixed(2)),
    remaining: Number((limit - spent).toFixed(2)),
    estimated: Number(task.estimatedBudget || 0),
    perNode: (graph?.nodes ?? []).map(node => ({
      key: node.key,
      phase: node.phase,
      status: node.status,
      // Reserved is the ceiling that was held. Actual is what the provider or
      // the runtime reported. Released is the difference, and it is the number
      // that shows the budget doing its job.
      reserved: node.cost.reserved,
      actual: node.cost.actual,
      // Kept apart rather than expressed as one signed number. A node that
      // spent more than it held did not "give back minus three cents"; it
      // overran, which is a different event and reads differently to a person.
      released: node.cost.actual === null
        ? null
        : Number(Math.max(0, node.cost.reserved - node.cost.actual).toFixed(2)),
      overrun: node.cost.actual === null
        ? null
        : Number(Math.max(0, node.cost.actual - node.cost.reserved).toFixed(2))
    })),
    reservations
  };
}

/**
 * Permissions, in every state they can be in.
 *
 * Denied and expired are listed as prominently as granted, because "why can it
 * not do this" is a question people ask far more often than "what can it do",
 * and an interface that only shows grants cannot answer it.
 */
function permissionPanel(db, task, agent) {
  const permission = db.toolPermissions.find(item => item.agentInstanceId === agent?.id) || null;
  const requests = db.permissionRequests.filter(item => item.agentInstanceId === agent?.id);
  const now = Date.now();

  const expired = request =>
    request.status === "approved" && request.expiresAt && Date.parse(request.expiresAt) <= now;

  return {
    // What the user agreed to when the task was created.
    authorized: [...(task.authorization?.toolScopes ?? [])],
    neverPreauthorized: [...(task.authorization?.neverPreauthorized ?? [])],
    executionLevel: task.executionLevel ?? task.authorization?.level ?? null,
    required: permission?.requiredScopes ?? [],
    granted: permission?.grantedScopes ?? [],
    // Narrow grants, with what is left of them.
    scopedGrants: (permission?.scopedGrants ?? []).map(grant => ({
      id: grant.id,
      toolKey: grant.toolKey,
      scope: grant.scope,
      scopes: grant.scopes,
      nodeId: grant.nodeId ?? null,
      usesRemaining: grant.usesRemaining,
      expiresAt: grant.expiresAt ?? null,
      lastUsedAt: grant.lastUsedAt ?? null
    })),
    pending: requests.filter(item => item.status === "pending" && !expired(item)),
    approved: requests.filter(item => item.status === "approved" && !expired(item)),
    denied: requests.filter(item => item.status === "denied"),
    expired: requests.filter(expired)
  };
}

/**
 * What has happened, in order.
 *
 * Drawn from the audit log rather than from anything this module writes, so it
 * cannot drift from what the system actually recorded. An activity feed that is
 * assembled separately from the audit trail is a second account of events, and
 * the two would eventually disagree.
 */
function activityPanel(db, task, agent, limit = 60) {
  const ids = new Set([task.id, agent?.id].filter(Boolean));
  const nodeIds = new Set(
    db.graphNodes.filter(node => node.taskId === task.id).map(node => node.id)
  );

  return db.auditLogs
    .filter(entry => ids.has(entry.resourceId) || nodeIds.has(entry.resourceId) ||
      entry.metadata?.taskId === task.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map(entry => ({
      id: entry.id,
      action: entry.action,
      outcome: entry.outcome,
      at: entry.createdAt,
      // The metadata is written by the code that recorded the event and is
      // already redacted there; nothing new is exposed by showing it.
      detail: entry.metadata ?? null
    }));
}

export async function taskControlCenter({ taskId, tenantId }) {
  const db = await loadDb();
  const task = db.tasks.find(item => item.id === taskId);
  if (!task) return null;
  if (tenantId && (task.tenantId || "local-tenant") !== tenantId) return null;

  const agent = task.agentInstanceId
    ? db.agentInstances.find(item => item.id === task.agentInstanceId)
    : null;

  const graph = await taskGraphView({ taskId, tenantId: task.tenantId || tenantId });
  const actions = await pendingUserActions({ taskId, tenantId: task.tenantId || tenantId });
  // Materialises version 1 from the task's own specification if it has never
  // been asked for. A task whose history appears empty is indistinguishable
  // from one that was never given an instruction.
  await currentInstruction(taskId);
  const instructions = await instructionHistory(taskId);

  const cycles = graph ? graphCycles(graph.nodes) : null;
  const running = graph?.nodes.find(node => node.status === "running") ?? null;
  const nextUp = graph?.nodes.filter(node => node.status === "ready") ?? [];
  // Between two nodes there is nothing running, which is most of the time when
  // a person happens to look. Naming the phase that just finished is more
  // useful than an empty field, and saying "after" keeps it honest.
  const lastFinished = (graph?.nodes ?? [])
    .filter(node => node.finishedAt)
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0] ?? null;

  return {
    overview: {
      id: task.id,
      title: task.title,
      taskType: task.taskType,
      status: task.status,
      agentType: task.agentType,
      agentStatus: agent?.status ?? null,
      executionLevel: task.executionLevel ?? null,
      instructionVersion: instructions.length ? instructions[instructions.length - 1].version : 1,
      // The phase a person would name, taken from whatever is actually running
      // rather than from a field something has to remember to update.
      currentPhase: graph?.status === "succeeded"
        ? "Complete"
        : running?.phase ?? (lastFinished ? "After " + lastFinished.phase.toLowerCase() : null),
      currentNode: running?.key ?? null,
      runningOn: running?.runningOn ?? null,
      queued: nextUp.map(node => node.key),
      repairCycles: cycles ? Math.max(0, cycles.highestReview - 1) : 0,
      executionCycles: cycles?.highestExec ?? 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    },
    graph,
    budget: budgetPanel(db, task, agent, graph),
    permissions: permissionPanel(db, task, agent),
    instructions: instructions.map(version => ({
      version: version.version,
      reason: version.reason,
      authoredBy: version.authoredBy,
      changeId: version.changeId,
      createdAt: version.createdAt,
      // The full text of every version, because the point of keeping them is
      // being able to read what was actually asked for at each point.
      text: version.text
    })),
    actions,
    activity: activityPanel(db, task, agent)
  };
}
