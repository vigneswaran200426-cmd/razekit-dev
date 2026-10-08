// Building a task record, and the identity it belongs to.
import { randomUUID } from 'node:crypto';
import { agentForTaskType } from './agents.js';
import { TASK_STATE, type AcceptanceCriterion, type DevTask, type Preflight, type TaskType } from './types.js';

/**
 * The DEV tenant for a RazeKit account.
 *
 * Prefixed rather than bare so a tenant id can never be confused with a user
 * id in a log, and so an organisation-level tenant can be introduced later
 * without colliding with the per-user ones already stored.
 */
export function tenantIdFor(user: { id: string }): string {
  return `rk-user-${user.id}`;
}

export const newTaskId = () => `dtk_${randomUUID().replace(/-/g, '')}`;
export const newWorkspaceId = () => `ws_${randomUUID().replace(/-/g, '')}`;

export const AUTHORIZATION_STATEMENT =
  'I authorise RazeKit to write code, run tests and build this on its own, inside an isolated workspace.';

export interface NewTaskInput {
  id?: string;
  userId: string;
  taskType: TaskType;
  title: string;
  originalRequest: string;
  maxBudgetMinor: number;
  currency: string;
  preflight: Preflight;
  userCriteria: string[];
  fundingMode: 'none' | 'ledger';
  at?: string;
}

export function buildTask(input: NewTaskInput): DevTask {
  const at = input.at ?? new Date().toISOString();
  const agent = agentForTaskType(input.taskType);
  const acceptance: AcceptanceCriterion[] = input.userCriteria.map((text, i) => ({
    id: `user-${i + 1}`,
    text,
    source: 'user',
    // A user's own words have no machine check until the plan maps them to
    // one. Until then they are shown, and verification treats them as unmet.
    check: null,
    status: 'pending',
  }));

  return {
    id: input.id ?? newTaskId(),
    tenantId: tenantIdFor({ id: input.userId }),
    userId: input.userId,
    taskType: input.taskType,
    agentType: agent.type,
    title: input.title,
    originalRequest: input.originalRequest,
    state: input.fundingMode === 'ledger' ? TASK_STATE.AWAITING_FUNDING : TASK_STATE.QUEUED,
    resumeState: null,
    stoppedFrom: null,
    maxBudgetMinor: input.maxBudgetMinor,
    spentMinor: 0,
    reservedMinor: 0,
    currency: input.currency,
    revision: 0,
    workspaceId: newWorkspaceId(),
    acceptance,
    preflight: input.preflight,
    authorization: { acceptedAt: at, acceptedBy: input.userId, statement: AUTHORIZATION_STATEMENT },
    attempts: { implement: 0, review: 0, verify: 0, transient: 0, invalidOutput: 0 },
    blackboard: {
      architecturePlan: null,
      executionPlan: null,
      lastResult: null,
      lastReview: null,
      refinements: [],
      repairNotes: [],
    },
    verification: { status: 'not_run', failures: [], checks: [], checkedAt: null },
    deliverables: [],
    artifact: null,
    decision: null,
    failure: null,
    funding: { mode: input.fundingMode, reservations: [], settlement: null },
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    nextRunAt: input.fundingMode === 'ledger' ? null : at,
  };
}
