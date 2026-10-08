// Where a build's money comes from: the payment → execution gate.
//
// Two modes, and which one a deployment runs is a configuration fact, not a
// runtime guess:
//
//   none    Local development and tests. The ceiling the user sets is enforced
//           by the governor, but no money is held against it. Refused in
//           production, where a build that spends provider money with nothing
//           behind it is RazeKit paying for someone else's software.
//
//   ledger  The build's whole ceiling is reserved out of the user's purchased
//           development budget BEFORE it may run, on RazeKit's existing
//           double-entry ledger — there is no second ledger. When the build
//           finishes, what it spent is consumed and the rest comes back as
//           development credit. Raising the ceiling mid-build reserves the
//           difference first.
//
// Every ledger operation for a user runs in one serializable transaction under
// a per-user advisory lock. The ledger's own reserve is check-then-post, and
// two builds started in the same instant would otherwise both see the same
// balance and both be approved against it.
import { DevError, ERR } from './engine/errors.js';
import type { DevTask, Reservation } from './engine/types.js';
import {
  developmentBalances,
  issueDevelopmentCredit,
  recordBudgetPurchase,
  releaseReservation,
  reserveBudget,
  captureSpend as ledgerCaptureSpend,
  spendDevelopmentCredit,
  existingReservation,
  reservationsForTask,
} from './ledger.js';
import { computeQuote } from '../money/fees.js';

export interface DevBalances {
  /** What a new build can draw on: purchased budget plus development credit. */
  spendableMinor: number;
  /** Purchased budget not yet committed to a build. */
  availableMinor: number;
  reservedMinor: number;
  consumedMinor: number;
  creditMinor: number;
  currency: string;
}

export interface Settlement {
  consumedMinor: number;
  creditedMinor: number;
}

export interface FundingGate {
  readonly mode: 'none' | 'ledger';
  /** The user's development money, or null when this deployment holds none. */
  balances(userId: string): Promise<DevBalances | null>;
  /** Reserves a new build's whole ceiling. Throws DEV_INSUFFICIENT_FUNDS. */
  secure(task: DevTask): Promise<Reservation | null>;
  /**
   * Reserves an increase to a running build's ceiling. `key` identifies the
   * one decision that raised it, so a retried approval reserves once and two
   * different approvals never collide.
   */
  secureIncrease(task: DevTask, deltaMinor: number, key: string): Promise<Reservation | null>;
  /** Returns everything a build reserved, untouched: it never ran. */
  releaseAll(task: DevTask): Promise<void>;
  /** Consumes what a finished build spent and credits the rest. Idempotent. */
  settle(task: DevTask): Promise<Settlement>;
}

const money = (minor: number) => `$${(Math.max(0, minor) / 100).toFixed(2)}`;

export class InsufficientFunds extends DevError {
  constructor(readonly requiredMinor: number, readonly availableMinor: number) {
    super(
      ERR.INSUFFICIENT_FUNDS,
      `This build needs ${money(requiredMinor)} of development budget and ${money(availableMinor)} is available.`,
      { httpStatus: 402 }
    );
  }
}

/** No money held. Local development and tests only. */
export class NoFunding implements FundingGate {
  readonly mode = 'none' as const;
  async balances() {
    return null;
  }
  async secure() {
    return null;
  }
  async secureIncrease() {
    return null;
  }
  async releaseAll() {}
  async settle(task: DevTask) {
    return { consumedMinor: task.spentMinor, creditedMinor: 0 };
  }
}

/** Runs `fn` with a ledger service client, serialised per user. */
export type LedgerUnitOfWork = <T>(userId: string, fn: (svc: any) => Promise<T>) => Promise<T>;

export class LedgerFunding implements FundingGate {
  readonly mode = 'ledger' as const;
  constructor(private deps: { unitOfWork: LedgerUnitOfWork; currency: string }) {}

  async balances(userId: string): Promise<DevBalances> {
    const b = await this.deps.unitOfWork(userId, (svc) => developmentBalances(svc, { userId, currency: this.deps.currency }));
    return {
      spendableMinor: b.availableMinor + b.developmentCreditMinor,
      availableMinor: b.availableMinor,
      reservedMinor: b.budgetReservedMinor,
      consumedMinor: b.executionSpendMinor,
      creditMinor: b.developmentCreditMinor,
      currency: this.deps.currency,
    };
  }

  private async reserve(task: DevTask, reservationId: string, amountMinor: number, reason: string): Promise<Reservation> {
    return this.deps.unitOfWork(task.userId, async (svc) => {
      // A retry of a reservation that already happened returns it as it is.
      // Checked before any balance arithmetic, because the balance already
      // has this reservation taken out of it.
      const already = await existingReservation(svc, { reservationId });
      if (already !== null) return { id: reservationId, amountMinor: already };

      // Credit returned from earlier builds is spent before a reservation
      // would fail for want of purchased budget. It is what credit is for,
      // and it is drawn only as far as it is needed.
      const before = await developmentBalances(svc, { userId: task.userId, currency: this.deps.currency });
      const shortfall = amountMinor - before.availableMinor;
      if (shortfall > 0) {
        if (shortfall > before.developmentCreditMinor) {
          throw new InsufficientFunds(amountMinor, before.availableMinor + before.developmentCreditMinor);
        }
        await spendDevelopmentCredit(svc, {
          userId: task.userId,
          taskId: task.id,
          amountMinor: shortfall,
          currency: this.deps.currency,
          actorId: task.userId,
          spendId: reservationId,
        });
      }
      try {
        await reserveBudget(svc, {
          userId: task.userId,
          taskId: task.id,
          reservationId,
          amountMinor,
          currency: this.deps.currency,
          reason,
          actorId: task.userId,
          actorRole: 'system',
        });
      } catch (e: any) {
        if (e?.code === 'DEV_BUDGET_EXCEEDED') {
          const b = await developmentBalances(svc, { userId: task.userId, currency: this.deps.currency });
          throw new InsufficientFunds(amountMinor, b.availableMinor + b.developmentCreditMinor);
        }
        throw e;
      }
      return { id: reservationId, amountMinor };
    });
  }

  secure(task: DevTask) {
    return this.reserve(task, `task:${task.id}:budget`, task.maxBudgetMinor, `Budget for build ${task.id}`);
  }

  secureIncrease(task: DevTask, deltaMinor: number, key: string) {
    return this.reserve(task, `task:${task.id}:raise:${key}`, deltaMinor, `Budget increase for build ${task.id}`);
  }

  /** The task's reservations as the ledger knows them, plus any it recorded itself. */
  private async allReservations(svc: any, task: DevTask): Promise<Reservation[]> {
    const posted = await reservationsForTask(svc, { userId: task.userId, taskId: task.id, currency: this.deps.currency });
    const byId = new Map<string, Reservation>();
    for (const r of [...task.funding.reservations, ...posted]) if (!byId.has(r.id)) byId.set(r.id, r);
    // Base budget first, then raises in the order they were taken.
    return [...byId.values()].sort((a, b) => Number(!a.id.endsWith(':budget')) - Number(!b.id.endsWith(':budget')));
  }

  async releaseAll(task: DevTask) {
    await this.deps.unitOfWork(task.userId, async (svc) => {
      for (const r of await this.allReservations(svc, task)) {
        await releaseReservation(svc, {
          userId: task.userId,
          taskId: task.id,
          reservationId: r.id,
          amountMinor: r.amountMinor,
          currency: this.deps.currency,
          reason: `Build ${task.id} never ran`,
          actorId: task.userId,
        });
      }
    });
  }

  async settle(task: DevTask): Promise<Settlement> {
    return this.deps.unitOfWork(task.userId, async (svc) => {
      const reservations = await this.allReservations(svc, task);
      const reserved = reservations.reduce((sum, r) => sum + r.amountMinor, 0);
      const spent = Math.min(task.spentMinor, reserved);
      // Spend is allocated to reservations in the order they were taken, so
      // each capture stays within its own reservation. Every posting is keyed
      // on its reservation, so settling twice posts nothing the second time.
      let remaining = spent;
      for (const r of reservations) {
        const actual = Math.min(remaining, r.amountMinor);
        remaining -= actual;
        await ledgerCaptureSpend(svc, {
          userId: task.userId,
          taskId: task.id,
          reservationId: r.id,
          reservedMinor: r.amountMinor,
          actualMinor: actual,
          currency: this.deps.currency,
          reason: `Settled build ${task.id}`,
          actorId: task.userId,
        });
      }
      const unused = reserved - spent;
      if (unused > 0) {
        await issueDevelopmentCredit(svc, {
          userId: task.userId,
          taskId: task.id,
          amountMinor: unused,
          currency: this.deps.currency,
          actorId: task.userId,
        });
      }
      return { consumedMinor: spent, creditedMinor: unused };
    });
  }
}

/**
 * The platform fee on a development budget purchase, from the existing fee
 * engine rather than hard-coded arithmetic.
 */
export function quoteBudgetPurchase(budgetMinor: number, { currency, platformFeeBps }: { currency: string; platformFeeBps: number }) {
  const platformRule = {
    active: true,
    fee_model: 'PERCENTAGE',
    percentage_bps: platformFeeBps,
    version: `dev-platform-${platformFeeBps}bps`,
  };
  return computeQuote({ subtotalMinor: budgetMinor, currency, platformRule, processingRule: null, taxRule: null, discountMinor: 0 });
}

/**
 * Records a purchase an administrator has verified against a real, received
 * payment (the same manual-verification model the beta uses for contest
 * funding). Idempotent on the payment reference: recording the same payment
 * twice credits it once.
 */
export async function recordVerifiedPurchase(
  unitOfWork: LedgerUnitOfWork,
  input: { userId: string; budgetMinor: number; paymentReference: string; adminId: string; currency: string; platformFeeBps: number }
) {
  const quote = quoteBudgetPurchase(input.budgetMinor, input);
  if (!(quote.platformFeeMinor > 0)) {
    throw new DevError(ERR.VALIDATION, 'The development platform fee is not configured, so this purchase cannot be recorded.');
  }
  const result = await unitOfWork(input.userId, (svc) =>
    recordBudgetPurchase(svc, {
      userId: input.userId,
      budgetMinor: input.budgetMinor,
      platformFeeMinor: quote.platformFeeMinor,
      currency: input.currency,
      paymentId: input.paymentReference,
      actorId: input.adminId,
      actorRole: 'admin',
    })
  );
  return { quote, replayed: Boolean(result?.replayed), transactionId: result?.transaction?.id ?? null };
}
