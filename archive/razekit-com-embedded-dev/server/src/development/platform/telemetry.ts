// What every finished build teaches: its timings, retries, outcome and cost.
//
// Operational metadata only — never the request, the code, or anything the
// customer wrote — so it can be compared across tenants without leaking any.
// Recorded once per build (insertRecordOnce), when the build is settled.
import type { DevTask } from '../engine/types.js';
import type { DevStore } from '../store/types.js';

export const PHASES = ['plan', 'implement', 'execute', 'review', 'verify'] as const;
export type Phase = (typeof PHASES)[number];

/** The update events that open each phase, in order. The last closes verify. */
const MARKS = ['Build started', 'Plan ready', 'Code written', 'Tests and build passed', 'Review passed', 'Done'] as const;

export interface BuildTelemetry {
  taskId: string;
  taskType: string;
  agentType: string;
  outcome: string;
  failureCode: string | null;
  runtime: string;
  models: string;
  /** Milliseconds per phase, from the first time each phase began and ended. Null if never reached. */
  phases: Record<Phase, number | null>;
  /** Time spent going round again (repairs, requested changes): total minus the phases. */
  reworkMs: number;
  totalMs: number;
  attempts: { implement: number; review: number; verify: number };
  spentMinor: number;
  maxBudgetMinor: number;
  finishedAt: string;
}

export function telemetryOf(task: DevTask, events: { title: string; createdAt: string }[], ctx: { runtime: string; models: string }): BuildTelemetry {
  const first = (title: string) => {
    const e = events.find((x) => x.title === title);
    return e ? Date.parse(e.createdAt) : null;
  };
  const at = MARKS.map(first);
  const phases = {} as Record<Phase, number | null>;
  PHASES.forEach((p, i) => {
    const a = at[i];
    const b = at[i + 1];
    phases[p] = a !== null && b !== null && b >= a ? b - a : null;
  });
  const start = events.length ? Date.parse(events[0].createdAt) : Date.parse(task.createdAt);
  const end = Date.parse(task.completedAt ?? task.updatedAt);
  const totalMs = Math.max(0, end - start);
  const counted = Object.values(phases).reduce<number>((s, v) => s + (v ?? 0), 0);
  return {
    taskId: task.id,
    taskType: task.taskType,
    agentType: task.agentType,
    outcome: task.state,
    failureCode: task.failure?.code ?? null,
    runtime: ctx.runtime,
    models: ctx.models,
    phases,
    reworkMs: Math.max(0, totalMs - counted),
    totalMs,
    attempts: { implement: task.attempts.implement, review: task.attempts.review, verify: task.attempts.verify },
    spentMinor: task.spentMinor,
    maxBudgetMinor: task.maxBudgetMinor,
    finishedAt: new Date(end).toISOString(),
  };
}

export async function recordTelemetry(store: DevStore, task: DevTask, ctx: { runtime: string; models: string }) {
  const events = await store.listEvents(task.id, { kinds: ['update'] });
  return store.insertRecordOnce('telemetry', task.id, telemetryOf(task, events, ctx));
}
