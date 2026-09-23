import { reserveSpend, captureSpend, releaseSpend } from "./billing.js";
import { checkBudget, charge } from "./budget-manager.js";

// Per-node budget, on the billing primitives that already exist.
//
// This file adds no ledger, no reservation table and no limit of its own. It is
// a translation layer and nothing more:
//
//   JEV node  --(minor units)-->  reserveSpend / captureSpend / releaseSpend
//
// Everything that actually enforces a limit already lives in billing.js — the
// hard agent budget, the concurrent-reservation accounting that makes two nodes
// reserving at once see each other, and the tenant hourly ceiling. Duplicating
// any of that here would create a second answer to "can this spend", and the
// two would disagree the first time one of them changed.
//
// ── Units ───────────────────────────────────────────────────────────────────
//
// JEV nodes carry `budgetMinor`, an integer number of minor units, because
// money in a scheduler must not be a float. billing.js predates that and works
// in whole currency units as JavaScript numbers. The conversion happens here,
// once, at the only place the two meet — rather than being done ad hoc at each
// call site, which is how half a system ends up in cents and the other half in
// dollars.
//
// The float representation inside billing.js is a real weakness and is NOT
// fixed here: changing the unit of the existing ledger is a migration, not a
// refactor, and it would touch every Phase 11 test. It is recorded in
// docs/jev-dag.md as known and deliberate.

const MINOR_UNITS_PER_MAJOR = 100;

export function minorToMajor(minor) {
  return Math.max(0, Math.trunc(Number(minor) || 0)) / MINOR_UNITS_PER_MAJOR;
}

export function majorToMinor(major) {
  return Math.round(Math.max(0, Number(major) || 0) * MINOR_UNITS_PER_MAJOR);
}

/**
 * Hold this node's budget before it runs.
 *
 * The idempotency key is the node id and the attempt number. Keying on the node
 * alone would make a retry silently reuse the first attempt's reservation, so a
 * node that failed three times would only ever have reserved once; keying on
 * something random would let a replayed claim reserve twice for one attempt.
 *
 * Returns `{ reserved: false, reason }` rather than throwing when the budget
 * refuses. A node that cannot afford to run is an ordinary outcome the graph
 * has to record, not an exception that aborts the whole drain.
 */
export async function reserveNodeBudget({ node, agentInstanceId }) {
  const minor = Math.max(0, Math.trunc(Number(node.budgetMinor) || 0));

  if (minor === 0) {
    // Nothing to hold, but "nothing to hold" is not "free to run". A node
    // priced at zero — which is every node until an operator configures a cost
    // — would otherwise reach a paid provider with the agent's budget already
    // exhausted, because a zero reservation can never be refused. The headroom
    // check is what stops that, and it is the same ledger everything else uses.
    const headroom = await checkBudget(agentInstanceId, 0);
    if (headroom.remaining <= 0) {
      return {
        reserved: false,
        reservation: null,
        amountMinor: 0,
        reason: "Hard budget limit exceeded",
        limit: "agent-budget"
      };
    }
    return { reserved: true, reservation: null, amountMinor: 0 };
  }

  const idempotencyKey = "jev:" + node.id + ":attempt:" + Number(node.attempt || 1);

  try {
    const reservation = await reserveSpend(
      agentInstanceId,
      minorToMajor(minor),
      "jev-node:" + node.key,
      { idempotencyKey, category: "execution", provider: "internal" }
    );
    return { reserved: true, reservation, amountMinor: minor };
  } catch (error) {
    const message = error.message || "Budget reservation failed";
    return {
      reserved: false,
      reservation: null,
      amountMinor: minor,
      reason: message,
      // Both of these come from our own enforcement, never from a provider, so
      // neither is retryable. Retrying a limit that exists to stop us is the
      // infinite loop this codebase has already been bitten by once.
      limit: /hard budget limit/i.test(message) ? "agent-budget"
        : /spendperhour/i.test(message) ? "tenant-hourly"
        : "unknown"
    };
  }
}

/**
 * Settle the hold after the node ran.
 *
 * `actualMinor` omitted means the node cost what it reserved. Given, and lower,
 * the difference is released in the same transaction that captures the rest —
 * see captureSpend. Higher is refused there rather than quietly allowed.
 */
export async function captureNodeBudget({ reservation, actualMinor }) {
  if (!reservation) return null;
  if (actualMinor === undefined || actualMinor === null) {
    return captureSpend(reservation.id);
  }
  const requested = minorToMajor(actualMinor);
  // Never ask to capture more than is held; the reservation is the ceiling and
  // asking for more would turn a settlement into a thrown error at the end of
  // work that already succeeded.
  const capped = Math.min(requested, Number(reservation.amount || 0));
  return captureSpend(reservation.id, { actualAmount: capped });
}

/**
 * Settle a node against what it actually cost.
 *
 * captureNodeBudget alone is not enough for work whose real price is only known
 * afterwards — a model call. Capping the capture at the reservation, which is
 * all captureSpend can do, means a node priced at zero settles at zero however
 * much the provider actually charged: the ledger never sees the money and the
 * hard budget can never bind. That is not a smaller number, it is a missing
 * one.
 *
 * So the reservation is captured up to its ceiling and anything above it is
 * recorded as a direct charge. Recording an overrun after the fact is not as
 * good as reserving for it beforehand, and it is not meant to be: it is what
 * remains honest when the estimate was lower than the truth. The next node's
 * reservation then refuses, which is how the overrun stops the task instead of
 * compounding.
 *
 * `unrecordedMinor` is the part that could not be recorded because doing so
 * would itself breach the hard limit. It is returned rather than swallowed, so
 * the caller can surface a real discrepancy instead of the system quietly
 * believing it spent less than it did.
 */
export async function settleNodeSpend({ reservation, agentInstanceId, measuredMinor, reason = "model node" }) {
  const measured = measuredMinor === undefined || measuredMinor === null
    ? null
    : Math.max(0, Math.trunc(Number(measuredMinor) || 0));

  const reservedMinor = reservation ? majorToMinor(reservation.amount) : 0;
  let capturedMinor = 0;

  if (reservation) {
    capturedMinor = measured === null ? reservedMinor : Math.min(measured, reservedMinor);
    await captureSpend(reservation.id, { actualAmount: minorToMajor(capturedMinor) });
  }

  const overrunMinor = measured === null ? 0 : Math.max(0, measured - reservedMinor);
  let unrecordedMinor = 0;

  if (overrunMinor > 0) {
    // Record as much of the overrun as the hard limit can hold, then report the
    // rest. Recording none of it because some of it does not fit would leave
    // the ledger further from the truth, not closer, and would leave headroom
    // that does not exist for the next node to reserve against.
    const headroom = await checkBudget(agentInstanceId, 0);
    const affordableMinor = Math.min(overrunMinor, Math.max(0, majorToMinor(headroom.remaining)));

    if (affordableMinor > 0) {
      try {
        await charge(agentInstanceId, minorToMajor(affordableMinor), reason + " (above reservation)");
        capturedMinor += affordableMinor;
      } catch (error) {
        // The tenant's hourly ceiling can still refuse what the agent's own
        // budget would allow. The money is gone at the provider either way.
        unrecordedMinor = overrunMinor;
        return { capturedMinor, reservedMinor, overrunMinor, unrecordedMinor };
      }
    }

    unrecordedMinor = overrunMinor - affordableMinor;
  }

  return { capturedMinor, reservedMinor, overrunMinor, unrecordedMinor };
}

/**
 * Give the whole hold back. Used when the node never ran, or ran and failed in
 * a way that consumed nothing.
 */
export async function releaseNodeBudget({ reservation }) {
  if (!reservation) return null;
  return releaseSpend(reservation.id);
}
