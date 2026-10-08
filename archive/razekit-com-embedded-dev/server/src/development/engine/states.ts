// The build lifecycle, as a closed state machine.
//
//   awaiting_funding ─► queued ─► planning ─► implementing ─► executing ─► reviewing ─► verifying ─► completed
//                                                  ▲               │             │             │
//                                                  └─── repair ────┴── revise ───┴── re-work ──┘
//
// Any live state can stop at waiting_user (a question only the user can
// answer), fail, or be cancelled. Three rules are encoded here rather than
// trusted to the orchestrator:
//
//   1. Only verifying may complete a task. A passing review is an opinion; a
//      completed task is a fact about evidence, and only verification has it.
//   2. A revision goes back to implementing, never back to planning. The plan
//      is not re-litigated because one run failed.
//   3. A waiting task resumes exactly where it stopped, never somewhere else.
//
// Terminal states have no exits. A finished build that needs more work is a new
// build.
import { DevError, ERR } from './errors.js';
import { TASK_STATE as S, type DashboardStatus, type DevTask, type TaskState, type TaskStatus } from './types.js';

const LIVE: TaskState[] = [S.PLANNING, S.IMPLEMENTING, S.EXECUTING, S.REVIEWING, S.VERIFYING];
const STOP: TaskState[] = [S.WAITING_USER, S.FAILED, S.CANCELLED];

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  [S.AWAITING_FUNDING]: [S.QUEUED, S.FAILED, S.CANCELLED],
  [S.QUEUED]: [S.PLANNING, ...STOP],
  [S.PLANNING]: [S.IMPLEMENTING, ...STOP],
  [S.IMPLEMENTING]: [S.EXECUTING, ...STOP],
  [S.EXECUTING]: [S.REVIEWING, S.IMPLEMENTING, ...STOP],
  [S.REVIEWING]: [S.VERIFYING, S.IMPLEMENTING, ...STOP],
  [S.VERIFYING]: [S.COMPLETED, S.IMPLEMENTING, ...STOP],
  [S.WAITING_USER]: [S.QUEUED, ...LIVE, S.FAILED, S.CANCELLED],
  [S.COMPLETED]: [],
  [S.FAILED]: [],
  [S.CANCELLED]: [],
};

export const TERMINAL: ReadonlySet<TaskState> = new Set([S.COMPLETED, S.FAILED, S.CANCELLED]);

/** States a worker advances. Everything else is waiting on someone. */
export const RUNNABLE: ReadonlySet<TaskState> = new Set([S.QUEUED, ...LIVE]);

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new DevError(ERR.STATE, `A build cannot move from ${from} to ${to}.`, { httpStatus: 409 });
  }
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

type TransitionOptions = {
  at?: string;
  /**
   * Where a waiting build resumes. Defaults to the state it stopped in; the
   * only alternative is implementing, for a stop whose answer is new work
   * (a reviewer that blocked, a change the user approved).
   */
  resumeTo?: TaskState;
  /** Required when stopping at waiting_user: the question being asked. */
  decision?: DevTask['decision'];
  failure?: DevTask['failure'];
};

/**
 * Returns the task moved to `to`. Pure: it never writes anything.
 *
 * Scheduling follows from the state, so it is set here and nowhere else — a
 * task that is waiting or finished cannot be left with a pending run that a
 * worker would then pick up and act on.
 */
export function transition(task: DevTask, to: TaskState, opts: TransitionOptions = {}): DevTask {
  assertTransition(task.state, to);
  const at = opts.at ?? new Date().toISOString();

  if (task.state === S.WAITING_USER && to !== S.FAILED && to !== S.CANCELLED && to !== task.resumeState) {
    throw new DevError(
      ERR.STATE,
      `A waiting build resumes where it stopped (${task.resumeState}), not at ${to}.`,
      { httpStatus: 409 }
    );
  }
  if (to === S.WAITING_USER && !opts.decision) {
    throw new DevError(ERR.STATE, 'A build can only stop to ask the user a question it states.', { httpStatus: 500 });
  }
  if (to === S.FAILED && !opts.failure) {
    throw new DevError(ERR.STATE, 'A build can only fail with a stated reason.', { httpStatus: 500 });
  }

  const next: DevTask = {
    ...task,
    state: to,
    updatedAt: at,
    resumeState: to === S.WAITING_USER ? resumeTarget(task, opts.resumeTo) : null,
    decision: to === S.WAITING_USER ? opts.decision ?? null : null,
    failure: to === S.FAILED ? opts.failure ?? null : task.failure,
    nextRunAt: RUNNABLE.has(to) ? at : null,
    completedAt: isTerminal(to) ? at : task.completedAt,
    stoppedFrom:
      to === S.FAILED || to === S.CANCELLED
        ? (task.state === S.WAITING_USER ? task.resumeState : task.state)
        : task.stoppedFrom,
  };
  return next;
}

function resumeTarget(task: DevTask, requested?: TaskState): TaskState {
  if (!requested || requested === task.state) return task.state;
  if (requested === S.IMPLEMENTING && LIVE.includes(task.state)) return S.IMPLEMENTING;
  throw new DevError(ERR.STATE, `A build waiting in ${task.state} cannot resume at ${requested}.`, { httpStatus: 500 });
}

/** The status the build list shows. */
export function coarseStatus(state: TaskState): TaskStatus {
  switch (state) {
    case S.AWAITING_FUNDING:
    case S.WAITING_USER:
      return 'waiting_user';
    case S.QUEUED:
      return 'queued';
    case S.COMPLETED:
    case S.FAILED:
    case S.CANCELLED:
      return state;
    default:
      return 'running';
  }
}

/** The headline the Control Center shows. */
export function dashboardStatus(state: TaskState): DashboardStatus {
  switch (state) {
    case S.COMPLETED:
      return 'COMPLETED';
    case S.FAILED:
      return 'BLOCKED';
    case S.CANCELLED:
      return 'STOPPED';
    case S.WAITING_USER:
    case S.AWAITING_FUNDING:
      return 'DECISION NEEDED';
    default:
      return 'WORKING';
  }
}

/** Rough position in the pipeline, for the progress bar. Never exceeds 99 until completed. */
export function progressPercent(task: Pick<DevTask, 'state' | 'resumeState' | 'stoppedFrom'>): number {
  const { state } = task;
  const at =
    state === S.WAITING_USER && task.resumeState
      ? task.resumeState
      : (state === S.FAILED || state === S.CANCELLED) && task.stoppedFrom
        ? task.stoppedFrom
        : state;
  switch (at) {
    case S.AWAITING_FUNDING:
    case S.QUEUED:
      return 0;
    case S.PLANNING:
      return 10;
    case S.IMPLEMENTING:
      return 30;
    case S.EXECUTING:
      return 50;
    case S.REVIEWING:
      return 70;
    case S.VERIFYING:
      return 85;
    case S.COMPLETED:
      return 100;
    default:
      return 0;
  }
}
