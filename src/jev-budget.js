import { reserveSpend, captureSpend, releaseSpend } from "./billing.js";

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
  if (minor === 0) return { reserved: true, reservation: null, amountMinor: 0 };

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
 * Give the whole hold back. Used when the node never ran, or ran and failed in
 * a way that consumed nothing.
 */
export async function releaseNodeBudget({ reservation }) {
  if (!reservation) return null;
  return releaseSpend(reservation.id);
}
