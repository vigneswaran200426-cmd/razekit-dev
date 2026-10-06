// What the user sees, derived from what is stored.
//
// The Control Center renders these projections and derives nothing itself, so
// "what the screen says" and "what the backend believes" cannot drift apart.
// Internal machinery — plans, prompts, raw tool output, reservations, leases —
// never leaves this file: the user asked for a website, not a tour of the
// scheduler.
import { stepSummary } from './engine/dag.js';
import { toMajor } from './engine/pricing.js';
import { coarseStatus, dashboardStatus, progressPercent } from './engine/states.js';
import type { DevChange, DevEvent, DevTask } from './engine/types.js';

export function taskSummary(task: DevTask) {
  return {
    id: task.id,
    title: task.title,
    taskType: task.taskType,
    agentType: task.agentType,
    status: coarseStatus(task.state),
    state: task.state,
    originalRequest: task.originalRequest,
    maxBudget: toMajor(task.maxBudgetMinor),
    actualSpend: toMajor(task.spentMinor),
    currency: task.currency,
    tenantId: task.tenantId,
    userId: task.userId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

export function taskDetail(task: DevTask) {
  return {
    ...taskSummary(task),
    workspaceId: task.workspaceId,
    preflight: task.preflight,
    delivery: task.delivery ?? null,
    acceptance: acceptanceView(task),
    verification: verificationView(task),
    deliverables: task.deliverables.map((d) => ({ path: d.path, bytes: d.bytes })),
    artifact: task.artifact ? { bytes: task.artifact.bytes, sha256: task.artifact.sha256 } : null,
    decision: task.decision,
    failure: task.failure,
    attempts: task.attempts,
    authorization: task.authorization,
  };
}

export function acceptanceView(task: DevTask) {
  return task.acceptance.map((c) => ({ id: c.id, text: c.text, source: c.source, status: c.status, evidence: c.evidence ?? null }));
}

function verificationView(task: DevTask) {
  return {
    status: task.verification.status,
    failures: task.verification.failures,
    checks: task.verification.checks,
    checkedAt: task.verification.checkedAt,
  };
}

export function eventView(e: DevEvent) {
  return { id: e.id, status: e.status, title: e.title, message: e.message, createdAt: e.createdAt };
}

/** Marks a pending change that is a question from the build, not a request from the user. */
export const DECISION_PREFIX = '[decision] ';

export function changeView(c: DevChange) {
  const fromBuild = c.content.startsWith(DECISION_PREFIX);
  return {
    id: c.id,
    // Who is asking: the user asked for a change, or the build stopped to ask.
    origin: fromBuild ? ('build' as const) : ('user' as const),
    content: fromBuild ? c.content.slice(DECISION_PREFIX.length) : c.content,
    classification: c.classification,
    status: c.status,
    reason: c.reason,
    budgetSnapshot: c.budgetSnapshot,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
  };
}

export function dashboard(task: DevTask, { events, changes }: { events: DevEvent[]; changes: DevChange[] }) {
  const updates = events.filter((e) => e.kind === 'update');
  // Oldest first, so the conversation reads top to bottom.
  const chat = events
    .filter((e) => e.kind === 'chat')
    .reverse()
    .map((e) => ({ id: e.id, role: e.role ?? 'system', content: e.message, createdAt: e.createdAt }));
  const max = task.maxBudgetMinor;
  return {
    task: taskSummary(task),
    delivery: task.delivery ?? null,
    status: dashboardStatus(task.state),
    progress: {
      percent: progressPercent(task),
      phase: task.state === 'waiting_user' ? task.resumeState : task.state,
      steps: stepSummary(task.blackboard.lastResult?.steps),
    },
    budget: {
      currentSpend: toMajor(task.spentMinor),
      reserved: toMajor(task.reservedMinor),
      maxBudget: toMajor(max),
      remaining: toMajor(Math.max(0, max - task.spentMinor - task.reservedMinor)),
      percentUsed: max > 0 ? Math.min(100, Math.round((task.spentMinor / max) * 100)) : 0,
      currency: task.currency,
    },
    verification: verificationView(task),
    deliverables: task.deliverables.map((d) => ({ path: d.path, bytes: d.bytes })),
    artifact: task.artifact ? { bytes: task.artifact.bytes, sha256: task.artifact.sha256 } : null,
    decision: task.decision,
    failure: task.failure,
    pendingDecisions: changes.filter((c) => c.status === 'pending').map(changeView),
    chat,
    events: updates.map(eventView),
  };
}
