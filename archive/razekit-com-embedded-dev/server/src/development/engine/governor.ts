// The budget governor: nothing that costs money runs without a reservation.
//
//   reserve the most this call can cost ─► make the call ─► capture what it cost
//                     │                                          │
//                     └── refused: the build stops and asks ◄────┘ unused returns at once
//
// The reservation is taken before the call, against the task's ceiling, in one
// atomic store operation — so two calls racing for the last of a budget cannot
// both be approved, and a build can never discover it overspent after the fact.
// A refused reservation is not an error to retry: it is the build reaching the
// limit the user set, and the right response is to stop and ask them.
import { randomUUID } from 'node:crypto';
import { DevError, ERR } from './errors.js';
import type { DevStore } from '../store/types.js';
import type { DevTask, SpendRecord } from './types.js';

export class BudgetExceeded extends DevError {
  requiredMinor: number;
  availableMinor: number;
  constructor(requiredMinor: number, availableMinor: number, operation: string) {
    super(
      ERR.BUDGET_EXCEEDED,
      `The next step (${operation}) can cost up to ${requiredMinor} and only ${Math.max(0, availableMinor)} of the budget is left.`,
      { httpStatus: 402, retryable: false }
    );
    this.requiredMinor = requiredMinor;
    this.availableMinor = availableMinor;
  }
}

export interface MeterSpec {
  /** Stable for one attempt at one step, so a retried tick reserves once. */
  reservationId: string;
  kind: SpendRecord['kind'];
  provider: string;
  operation: string;
  /** The most the call can cost. Must be a true upper bound. */
  ceilingMinor: number;
}

export interface Metered<T> {
  value: T;
  costMinor: number;
}

/**
 * Errors from a call that was billed anyway — a provider answered, and the
 * answer was unusable. The cost is real and is captured, not released.
 */
export class BilledFailure extends Error {
  constructor(readonly cause: unknown, readonly costMinor: number) {
    super((cause as Error)?.message || 'The provider call failed after it was billed.');
  }
}

export class BudgetGovernor {
  constructor(private store: DevStore) {}

  async run<T>(task: DevTask, spec: MeterSpec, call: () => Promise<Metered<T>>): Promise<{ value: T; chargedMinor: number; overrunMinor: number }> {
    const ceiling = Math.max(0, Math.ceil(spec.ceilingMinor));
    let reservationId = spec.reservationId;
    let reserved = await this.store.reserveSpend({
      taskId: task.id,
      reservationId,
      kind: spec.kind,
      provider: spec.provider,
      operation: spec.operation,
      amountMinor: ceiling,
    });
    if (!reserved.ok) throw new BudgetExceeded(ceiling, reserved.availableMinor, spec.operation);

    if (reserved.replayed && reserved.record.status !== 'reserved') {
      // This exact step already ran and settled, then the worker died before
      // saving the result. Running it again is RazeKit's failure, not the
      // customer's: the re-run is reserved at zero, so whatever it costs is
      // recorded as RazeKit's overrun and never charged against the budget.
      reservationId = `${spec.reservationId}:recovery:${randomUUID().slice(0, 8)}`;
      reserved = await this.store.reserveSpend({
        taskId: task.id,
        reservationId,
        kind: spec.kind,
        provider: spec.provider,
        operation: spec.operation,
        amountMinor: 0,
      });
      if (!reserved.ok) throw new BudgetExceeded(0, reserved.availableMinor, spec.operation);
    }

    let result: Metered<T>;
    try {
      result = await call();
    } catch (e) {
      if (e instanceof BilledFailure) {
        // A billed answer that was unusable: the cost is real and is charged,
        // and the caller sees the reason it was unusable, not the wrapper.
        if (e.costMinor > 0) await this.store.captureSpend(task.id, reservationId, e.costMinor);
        else await this.store.releaseSpend(task.id, reservationId);
        throw e.cause instanceof Error ? e.cause : e;
      }
      // No answer came back, so nothing was billed: the reservation returns
      // whole. Distinct from capturing zero, which would mean a call happened.
      await this.store.releaseSpend(task.id, reservationId);
      throw e;
    }
    const captured = await this.store.captureSpend(task.id, reservationId, result.costMinor);
    return { value: result.value, chargedMinor: captured.actualMinor ?? 0, overrunMinor: captured.overrunMinor };
  }

  /** What is left under the ceiling right now. */
  static remaining(task: Pick<DevTask, 'maxBudgetMinor' | 'spentMinor' | 'reservedMinor'>): number {
    return Math.max(0, task.maxBudgetMinor - task.spentMinor - task.reservedMinor);
  }
}
