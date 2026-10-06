// @ts-nocheck
// The money side of RazeKit DEV.
//
// This deliberately adds account classes to the existing chart of accounts in
// ledger/accounts.ts rather than starting a second ledger. RazeKit already has
// double-entry with balanced postings, idempotency and balance replay; a
// parallel "development credit balance" column would be a second source of
// financial truth in one product, and the two would disagree the first time a
// worker crashed between two writes.
//
// Four new pots, and the boundaries between them are the whole point:
//
//   DEV_BUDGET_HELD      purchased development budget, not yet committed
//   DEV_BUDGET_RESERVED  committed to one in-flight operation, unspendable
//   DEV_BUDGET_CONSUMED  budget actually used up by execution
//   DEV_CREDIT           unused budget returned as non-withdrawable credit
//
// DEV_BUDGET_CONSUMED records the customer's budget being used, not RazeKit's
// bill from a provider. Those are different numbers — the provider invoice is
// RazeKit's own expense and settles on its own cycle — and conflating them
// would make a customer's remaining budget depend on when a vendor invoiced.
//
// The reason RESERVED is its own account rather than a flag: two concurrent
// model calls must not both look at the same remaining balance and both decide
// they fit. Money leaves HELD at reservation time, so the second caller sees a
// smaller balance without anything having been spent yet.

import {
  ACCOUNT_CLASS,
  NORMAL_SIDE,
  OWNER_TYPE,
  balanceOf,
  getOrCreateAccount,
} from '../ledger/accounts.js';
import { postTransaction, DIRECTION } from '../ledger/post.js';

/** Development-specific account classes, registered alongside the contest ones. */
export const DEV_ACCOUNT_CLASS = {
  DEV_BUDGET_HELD: 'DEV_BUDGET_HELD',
  DEV_BUDGET_RESERVED: 'DEV_BUDGET_RESERVED',
  DEV_BUDGET_CONSUMED: 'DEV_BUDGET_CONSUMED',
  DEV_CREDIT: 'DEV_CREDIT',
};

/**
 * Normal balance sides. All four grow with credits.
 *
 * Held, reserved and credit are money owed back to the customer. Consumed is
 * the customer's claim being extinguished as work is done — RazeKit keeps that
 * money, so it grows on the same side. Every posting in this module therefore
 * moves value between four credit-normal pots whose total is invariant, which
 * is what makes the reconciliation test below meaningful rather than circular.
 */
export const DEV_NORMAL_SIDE = {
  DEV_BUDGET_HELD: 'CREDIT',
  DEV_BUDGET_RESERVED: 'CREDIT',
  DEV_BUDGET_CONSUMED: 'CREDIT',
  DEV_CREDIT: 'CREDIT',
};

export const DEV_TXN_TYPE = {
  BUDGET_PURCHASED: 'DEV_BUDGET_PURCHASED',
  BUDGET_RESERVED: 'DEV_BUDGET_RESERVED',
  SPEND_CAPTURED: 'DEV_SPEND_CAPTURED',
  RESERVATION_RELEASED: 'DEV_RESERVATION_RELEASED',
  CREDIT_ISSUED: 'DEV_CREDIT_ISSUED',
  CREDIT_SPENT: 'DEV_CREDIT_SPENT',
};

export class DevLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DevLedgerError';
    this.code = code;
  }
}

function assertMinor(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new DevLedgerError('DEV_LEDGER_AMOUNT', `${label} must be a positive integer in minor units, got ${value}.`);
  }
  return n;
}

/**
 * Records a verified development-budget purchase.
 *
 * Called only after the payment provider's webhook has been verified — never
 * from a frontend success signal. The platform fee is split out here rather
 * than folded into the budget, because they are different pots with different
 * meanings: the fee is RazeKit revenue the moment it is taken, the budget is
 * money still owed back to the customer as credit if it goes unspent.
 *
 * @param {object} svc            entity service
 * @param {string} userId         the paying RazeKit account
 * @param {number} budgetMinor    development budget, minor units
 * @param {number} platformFeeMinor  the 15% fee, computed by money/fees.ts
 * @param {string} paymentId      provider payment reference, for reconciliation
 */
export async function recordBudgetPurchase(svc, {
  userId,
  budgetMinor,
  platformFeeMinor,
  currency,
  paymentId,
  actorId,
  actorRole = 'system',
}) {
  const budget = assertMinor(budgetMinor, 'Development budget');
  const fee = assertMinor(platformFeeMinor, 'Platform fee');
  if (!userId) throw new DevLedgerError('DEV_LEDGER_USER', 'A user is required.');
  if (!paymentId) throw new DevLedgerError('DEV_LEDGER_PAYMENT', 'A verified payment reference is required.');

  return postTransaction(svc, {
    txnType: DEV_TXN_TYPE.BUDGET_PURCHASED,
    currency,
    // Keyed on the provider payment. A replayed webhook — which providers do
    // send — returns the original transaction instead of crediting twice.
    idempotencyKey: `dev:purchase:${paymentId}`,
    description: `Development budget purchased (payment ${paymentId})`,
    actorId,
    actorRole,
    lines: [
      { accountClass: ACCOUNT_CLASS.BANK_SETTLEMENT, direction: DIRECTION.DEBIT, amountMinor: budget + fee },
      { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD, subjectId: userId, direction: DIRECTION.CREDIT, amountMinor: budget },
      { accountClass: ACCOUNT_CLASS.PLATFORM_FEE, direction: DIRECTION.CREDIT, amountMinor: fee },
    ],
    metadata: { paymentId, userId },
  });
}

/**
 * Moves budget from held into a reservation for one operation.
 *
 * This is the budget governor's gate. It fails rather than overdrawing, and
 * because the money actually leaves the held account, a second concurrent
 * caller sees the reduced balance — two model calls cannot both be approved
 * against the same remaining funds.
 *
 * `reservationId` must be stable for the operation, so a retry of the same
 * model call reserves once rather than repeatedly.
 */
export async function reserveBudget(svc, {
  userId,
  taskId,
  reservationId,
  amountMinor,
  currency,
  reason,
  actorId,
  actorRole = 'system',
}) {
  const amount = assertMinor(amountMinor, 'Reservation');
  if (!reservationId) throw new DevLedgerError('DEV_LEDGER_RESERVATION', 'A reservation id is required.');

  // balanceOf returns { account, balance_minor } — the number is inside.
  const { balance_minor: available } = await balanceOf(svc, {
    accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD,
    currency,
    subjectId: userId,
  });

  if (available < amount) {
    // Refused, not truncated. A partially funded model call produces a
    // partially built project, which is worse than not starting it.
    throw new DevLedgerError(
      'DEV_BUDGET_EXCEEDED',
      `Reservation of ${amount} exceeds the available development budget of ${available}.`
    );
  }

  return postTransaction(svc, {
    txnType: DEV_TXN_TYPE.BUDGET_RESERVED,
    currency,
    idempotencyKey: `dev:reserve:${reservationId}`,
    description: reason || `Reserved for task ${taskId}`,
    actorId,
    actorRole,
    lines: [
      { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD, subjectId: userId, direction: DIRECTION.DEBIT, amountMinor: amount },
      { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_RESERVED, subjectId: userId, direction: DIRECTION.CREDIT, amountMinor: amount },
    ],
    metadata: { reservationId, taskId, userId },
  });
}

/**
 * Settles a reservation against what was actually spent.
 *
 * Providers bill less than the worst case almost every time, so the reservation
 * is an upper bound and this is where the truth lands. Unused reservation goes
 * straight back to held, in the same transaction — never left stranded in the
 * reserved account where it would be invisible to the next budget check.
 */
export async function captureSpend(svc, {
  userId,
  taskId,
  reservationId,
  reservedMinor,
  actualMinor,
  currency,
  reason,
  actorId,
  actorRole = 'system',
}) {
  const reserved = assertMinor(reservedMinor, 'Reserved amount');
  const actual = Number(actualMinor);
  if (!Number.isInteger(actual) || actual < 0) {
    throw new DevLedgerError('DEV_LEDGER_AMOUNT', `Actual spend must be a non-negative integer, got ${actualMinor}.`);
  }
  if (actual > reserved) {
    throw new DevLedgerError(
      'DEV_CAPTURE_EXCEEDS_RESERVATION',
      `Actual spend ${actual} exceeds the reservation ${reserved}. The governor reserves an upper bound; a larger bill means the estimate was wrong and must not be silently absorbed.`
    );
  }

  const unused = reserved - actual;

  // The reservation is dissolved in full, then split: what was used moves to
  // consumed, what was not returns to held. Debits equal credits by
  // construction because unused + actual is exactly the reservation.
  const lines = [
    { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_RESERVED, subjectId: userId, direction: DIRECTION.DEBIT, amountMinor: reserved },
  ];
  if (actual > 0) {
    lines.push({ accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_CONSUMED, subjectId: userId, direction: DIRECTION.CREDIT, amountMinor: actual });
  }
  if (unused > 0) {
    lines.push({ accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD, subjectId: userId, direction: DIRECTION.CREDIT, amountMinor: unused });
  }

  return postTransaction(svc, {
    txnType: DEV_TXN_TYPE.SPEND_CAPTURED,
    currency,
    idempotencyKey: `dev:capture:${reservationId}`,
    description: reason || `Captured spend for task ${taskId}`,
    actorId,
    actorRole,
    lines,
    metadata: { reservationId, taskId, userId, reservedMinor: reserved, actualMinor: actual, unusedMinor: unused },
  });
}

/**
 * The amount of a reservation already posted under this id, or null.
 *
 * Callers that do arithmetic before reserving (drawing on credit for a
 * shortfall) must check this first: on a retry the balance they would compute
 * from already has this reservation taken out of it.
 */
export async function existingReservation(svc, { reservationId }) {
  const found = await svc.entities.LedgerTransaction
    .filter({ idempotency_key: `dev:reserve:${reservationId}` }, '-created_date', 1)
    .catch(() => []);
  return found.length ? Number(found[0].amount_minor) : null;
}

/**
 * Every reservation ever posted for one task, read from the ledger itself.
 *
 * Settlement uses this rather than trusting the task's own list: a process
 * can die after the ledger reserved but before the task recorded it, and a
 * reservation the task does not know about would otherwise never be settled.
 * Reads only the user's own reserved account, so it is bounded by that
 * user's activity, not the platform's.
 */
export async function reservationsForTask(svc, { userId, taskId, currency }) {
  const account = await getOrCreateAccount(svc, { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_RESERVED, currency, subjectId: userId });
  const entries = await svc.entities.LedgerEntry.filter({ account_id: account.id }, 'created_date', 10000).catch(() => []);
  const prefix = `dev:reserve:task:${taskId}:`;
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (e.direction !== DIRECTION.CREDIT || seen.has(e.transaction_id)) continue;
    seen.add(e.transaction_id);
    const [txn] = await svc.entities.LedgerTransaction.filter({ id: e.transaction_id }, '-created_date', 1).catch(() => []);
    if (txn?.txn_type === DEV_TXN_TYPE.BUDGET_RESERVED && String(txn.idempotency_key || '').startsWith(prefix)) {
      out.push({ id: txn.idempotency_key.slice('dev:reserve:'.length), amountMinor: Number(txn.amount_minor) });
    }
  }
  return out;
}

/**
 * Returns a reservation untouched — the operation never ran.
 *
 * Distinct from capturing zero: a released reservation means no provider call
 * happened, a zero capture means one happened and cost nothing. The two read
 * identically on a balance and very differently in an audit.
 */
export async function releaseReservation(svc, {
  userId,
  taskId,
  reservationId,
  amountMinor,
  currency,
  reason,
  actorId,
  actorRole = 'system',
}) {
  const amount = assertMinor(amountMinor, 'Reservation');

  return postTransaction(svc, {
    txnType: DEV_TXN_TYPE.RESERVATION_RELEASED,
    currency,
    idempotencyKey: `dev:release:${reservationId}`,
    description: reason || `Released reservation for task ${taskId}`,
    actorId,
    actorRole,
    lines: [
      { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_RESERVED, subjectId: userId, direction: DIRECTION.DEBIT, amountMinor: amount },
      { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD, subjectId: userId, direction: DIRECTION.CREDIT, amountMinor: amount },
    ],
    metadata: { reservationId, taskId, userId },
  });
}

/**
 * Converts a finished task's unused budget into development credit.
 *
 * Credit is not cash and never becomes cash: there is deliberately no path
 * from DEV_CREDIT to BANK_SETTLEMENT anywhere in this module. It can only be
 * spent on future development work, which is what the product promises and
 * what keeps it out of money-transmission territory.
 */
export async function issueDevelopmentCredit(svc, {
  userId,
  taskId,
  amountMinor,
  currency,
  actorId,
  actorRole = 'system',
}) {
  const amount = assertMinor(amountMinor, 'Credit');

  return postTransaction(svc, {
    txnType: DEV_TXN_TYPE.CREDIT_ISSUED,
    currency,
    idempotencyKey: `dev:credit:${taskId}`,
    description: `Unused development budget returned as credit (task ${taskId})`,
    actorId,
    actorRole,
    lines: [
      { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD, subjectId: userId, direction: DIRECTION.DEBIT, amountMinor: amount },
      { accountClass: DEV_ACCOUNT_CLASS.DEV_CREDIT, subjectId: userId, direction: DIRECTION.CREDIT, amountMinor: amount },
    ],
    metadata: { taskId, userId },
  });
}

/**
 * Spends existing development credit on a task, instead of a fresh payment.
 *
 * `spendId` identifies this one application of credit — a task can draw on
 * credit more than once (its first reservation, and again if its ceiling is
 * raised), and each draw must be idempotent on its own, not collapse into the
 * first. Defaults to the task id for a single draw.
 */
export async function spendDevelopmentCredit(svc, {
  userId,
  taskId,
  amountMinor,
  currency,
  actorId,
  actorRole = 'system',
  spendId = '',
}) {
  const amount = assertMinor(amountMinor, 'Credit');

  const { balance_minor: available } = await balanceOf(svc, {
    accountClass: DEV_ACCOUNT_CLASS.DEV_CREDIT,
    currency,
    subjectId: userId,
  });
  if (available < amount) {
    throw new DevLedgerError(
      'DEV_CREDIT_EXCEEDED',
      `Requested ${amount} of development credit but only ${available} is available.`
    );
  }

  return postTransaction(svc, {
    txnType: DEV_TXN_TYPE.CREDIT_SPENT,
    currency,
    idempotencyKey: `dev:credit-spend:${spendId || taskId}`,
    description: `Development credit applied to task ${taskId}`,
    actorId,
    actorRole,
    lines: [
      { accountClass: DEV_ACCOUNT_CLASS.DEV_CREDIT, subjectId: userId, direction: DIRECTION.DEBIT, amountMinor: amount },
      { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD, subjectId: userId, direction: DIRECTION.CREDIT, amountMinor: amount },
    ],
    metadata: { taskId, userId, spendId: spendId || taskId },
  });
}

/**
 * Everything the dashboard needs to show, read from the ledger rather than
 * from any cached column. §24 of the dashboard mandate requires these be
 * distinct numbers, and they are distinct accounts.
 */
export async function developmentBalances(svc, { userId, currency }) {
  const [held, reserved, spent, credit] = await Promise.all([
    balanceOf(svc, { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_HELD, currency, subjectId: userId }),
    balanceOf(svc, { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_RESERVED, currency, subjectId: userId }),
    balanceOf(svc, { accountClass: DEV_ACCOUNT_CLASS.DEV_BUDGET_CONSUMED, currency, subjectId: userId }),
    balanceOf(svc, { accountClass: DEV_ACCOUNT_CLASS.DEV_CREDIT, currency, subjectId: userId }),
  ]);

  return {
    budgetHeldMinor: held.balance_minor,
    budgetReservedMinor: reserved.balance_minor,
    executionSpendMinor: spent.balance_minor,
    developmentCreditMinor: credit.balance_minor,
    // What a new reservation can actually draw on. Reserved money is already
    // committed, so it is excluded — this is the number the governor checks.
    availableMinor: held.balance_minor,
    currency,
  };
}
