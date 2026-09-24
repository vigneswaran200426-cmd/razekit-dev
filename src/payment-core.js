import { createHash } from "node:crypto";
import { loadDb, transact, id } from "./store.js";
import { writeAudit } from "./tenant-security.js";

// Money coming IN.
//
// This is not the same system as billing.js and must not be confused with it.
// billing.js is internal: it reserves and settles a task's own budget against
// what the platform spends on the task's behalf. This is external: a person
// pays RazeKit, and what they paid becomes budget the task is allowed to use.
//
//   customer pays  ->  provider verifies  ->  RazeKit records  ->  task funded
//                                                     |
//                                              billing.js starts here
//
// Three rules the whole file exists to hold:
//
//   THE AMOUNT IS OURS.     A quote fixes the amount server-side. Nothing the
//                           browser sends, and nothing a webhook claims, can
//                           change what is owed. A client that could name its
//                           own price is not a payment system.
//
//   A WEBHOOK IS A HINT.    It says "something happened, go and look". It never
//                           sets PAID by itself. Webhooks can be forged,
//                           replayed, delivered late, delivered twice, or never
//                           delivered at all — the authoritative answer is the
//                           provider's own record of the order.
//
//   UNKNOWN IS A STATE.     "We could not determine whether this was paid" is a
//                           real answer and gets its own status. Guessing in
//                           either direction is worse: guessing PAID gives away
//                           work, guessing FAILED takes money for nothing.

export const PAYMENT_STATUS = {
  QUOTED: "quoted",
  PENDING: "pending",
  VERIFYING: "verifying",
  PAID: "paid",
  FAILED: "failed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  RECONCILIATION_REQUIRED: "reconciliation_required"
};

const TERMINAL = new Set([
  PAYMENT_STATUS.PAID,
  PAYMENT_STATUS.FAILED,
  PAYMENT_STATUS.EXPIRED,
  PAYMENT_STATUS.CANCELLED
]);

// What may follow what. Written out rather than left implicit, because the
// transitions that must NOT exist are the point: nothing returns from PAID, and
// nothing reaches PAID except through a provider lookup.
const ALLOWED = {
  [PAYMENT_STATUS.QUOTED]: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.EXPIRED],
  [PAYMENT_STATUS.PENDING]: [
    PAYMENT_STATUS.VERIFYING, PAYMENT_STATUS.PAID, PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.EXPIRED, PAYMENT_STATUS.CANCELLED,
    // A lookup made from PENDING can discover a discrepancy — an amount that
    // does not match, or a provider that cannot answer — without having passed
    // through VERIFYING first. Forcing it through would mean the order sat in
    // PENDING while we already knew it needed a person.
    PAYMENT_STATUS.RECONCILIATION_REQUIRED
  ],
  [PAYMENT_STATUS.VERIFYING]: [
    PAYMENT_STATUS.PAID, PAYMENT_STATUS.FAILED, PAYMENT_STATUS.EXPIRED,
    PAYMENT_STATUS.RECONCILIATION_REQUIRED
  ],
  [PAYMENT_STATUS.RECONCILIATION_REQUIRED]: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.PAID]: [],
  [PAYMENT_STATUS.FAILED]: [],
  [PAYMENT_STATUS.EXPIRED]: [],
  [PAYMENT_STATUS.CANCELLED]: []
};

export function canTransition(from, to) {
  return (ALLOWED[from] ?? []).includes(to);
}

export function isTerminalPaymentStatus(status) {
  return TERMINAL.has(status);
}

// ── Quote ───────────────────────────────────────────────────────────────────

/**
 * Fix what is owed, server-side.
 *
 * The caller says what the payment is FOR; it does not say what it costs. That
 * distinction is the difference between a price and a suggestion.
 */
export async function createQuote({
  tenantId,
  userId,
  taskId = null,
  purpose,
  amountMinor,
  currency = "INR",
  metadata = {},
  expiresInMs = 30 * 60_000,
  now = new Date()
}) {
  const amount = Math.trunc(Number(amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("A quote requires a positive amount in minor units");
  }
  if (!tenantId) throw new Error("A quote requires a tenant");
  if (!purpose) throw new Error("A quote requires a purpose");

  const order = {
    id: id("pay"),
    tenantId,
    userId: userId ?? null,
    taskId,
    purpose,
    // Minor units, integer, always. A float here is a rounding error waiting
    // for a currency with more than two decimal places.
    amountMinor: amount,
    currency,
    status: PAYMENT_STATUS.QUOTED,
    provider: null,
    providerOrderId: null,
    providerStatus: null,
    // What the provider says was actually paid, which is not assumed to equal
    // what was asked for until it has been checked.
    paidAmountMinor: null,
    metadata,
    fundedAt: null,
    fundingId: null,
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    history: [{ status: PAYMENT_STATUS.QUOTED, at: now.toISOString(), by: "system" }]
  };

  await transact(db => db.paymentOrders.push(order));
  await writeAudit({
    tenantId, userId,
    action: "payment.quoted",
    resourceType: "payment_order",
    resourceId: order.id,
    metadata: { amountMinor: amount, currency, purpose, taskId }
  }).catch(() => undefined);

  return order;
}

export async function getPaymentOrder(orderId, { tenantId = null } = {}) {
  const db = await loadDb();
  const order = db.paymentOrders.find(item => item.id === orderId);
  if (!order) return null;
  if (tenantId && order.tenantId !== tenantId) return null;
  return order;
}

export async function listPaymentOrders({ tenantId = null, taskId = null, status = null } = {}) {
  const db = await loadDb();
  return db.paymentOrders.filter(order =>
    (tenantId ? order.tenantId === tenantId : true) &&
    (taskId ? order.taskId === taskId : true) &&
    (status ? order.status === status : true)
  );
}

// ── Transitions ─────────────────────────────────────────────────────────────

/**
 * Move an order to a new status, or explain why not.
 *
 * Idempotent by construction: asking for the status it already has succeeds and
 * changes nothing. A provider that delivers the same event twice — which they
 * all do — must not produce two effects.
 */
async function transition(orderId, next, { by = "system", detail = null, patch = {}, now = new Date() }) {
  return transact(db => {
    const order = db.paymentOrders.find(item => item.id === orderId);
    if (!order) throw new Error("Payment order not found: " + orderId);

    if (order.status === next) {
      // Already there. Not an error, and deliberately not a second history
      // entry: a replayed webhook should leave no trace of having been replayed
      // beyond the deduplication record.
      return { changed: false, order: { ...order } };
    }

    if (!canTransition(order.status, next)) {
      return {
        changed: false,
        refused: true,
        reason: "A payment cannot go from " + order.status + " to " + next,
        order: { ...order }
      };
    }

    Object.assign(order, patch);
    order.status = next;
    order.updatedAt = now.toISOString();
    order.history.push({ status: next, at: now.toISOString(), by, detail });

    return { changed: true, order: { ...order } };
  });
}

/** Record that a provider order now exists for this quote. */
export async function attachProviderOrder(orderId, { provider, providerOrderId, now = new Date() }) {
  if (!provider || !providerOrderId) throw new Error("A provider order requires a provider and an id");
  const result = await transition(orderId, PAYMENT_STATUS.PENDING, {
    by: provider,
    patch: { provider, providerOrderId },
    now
  });
  if (result.changed) {
    await writeAudit({
      tenantId: result.order.tenantId,
      action: "payment.provider_order_created",
      resourceType: "payment_order",
      resourceId: orderId,
      metadata: { provider, providerOrderId }
    }).catch(() => undefined);
  }
  return result;
}

/**
 * Settle an order against what the PROVIDER says, not against what anyone told
 * us.
 *
 * `lookup` is the provider's authoritative record. It is the only input that
 * can produce PAID, and even then the amount is checked: a provider reporting a
 * payment smaller than the quote is not a paid order, it is a discrepancy, and
 * treating it as paid is how a task gets funded for more than was collected.
 */
export async function settleFromProviderLookup(orderId, lookup, { now = new Date() } = {}) {
  const order = await getPaymentOrder(orderId);
  if (!order) throw new Error("Payment order not found: " + orderId);

  if (isTerminalPaymentStatus(order.status)) {
    return { changed: false, order, reason: "already-settled" };
  }

  if (!lookup || lookup.status === "unknown") {
    const moved = await transition(orderId, PAYMENT_STATUS.RECONCILIATION_REQUIRED, {
      by: order.provider || "provider",
      detail: { reason: lookup?.reason || "the provider could not be reached" },
      now
    });
    await writeAudit({
      tenantId: order.tenantId,
      action: "payment.reconciliation_required",
      resourceType: "payment_order",
      resourceId: orderId,
      outcome: "failure",
      metadata: { provider: order.provider, reason: lookup?.reason ?? null }
    }).catch(() => undefined);
    return moved;
  }

  if (lookup.status === "paid") {
    const paidMinor = Math.trunc(Number(lookup.amountMinor));
    if (!Number.isFinite(paidMinor) || paidMinor < order.amountMinor) {
      // Short payment. Not paid, not failed — a human has to decide, because
      // the money exists but does not match what was owed.
      const moved = await transition(orderId, PAYMENT_STATUS.RECONCILIATION_REQUIRED, {
        by: order.provider || "provider",
        detail: { reason: "amount-mismatch", expectedMinor: order.amountMinor, reportedMinor: paidMinor },
        patch: { providerStatus: lookup.status, paidAmountMinor: Number.isFinite(paidMinor) ? paidMinor : null },
        now
      });
      await writeAudit({
        tenantId: order.tenantId,
        action: "payment.amount_mismatch",
        resourceType: "payment_order",
        resourceId: orderId,
        outcome: "failure",
        metadata: { expectedMinor: order.amountMinor, reportedMinor: paidMinor }
      }).catch(() => undefined);
      return moved;
    }

    const moved = await transition(orderId, PAYMENT_STATUS.PAID, {
      by: order.provider || "provider",
      patch: {
        providerStatus: lookup.status,
        paidAmountMinor: paidMinor,
        providerOrderId: lookup.providerOrderId ?? order.providerOrderId
      },
      now
    });
    if (moved.changed) {
      await writeAudit({
        tenantId: order.tenantId,
        action: "payment.paid",
        resourceType: "payment_order",
        resourceId: orderId,
        metadata: { provider: order.provider, paidMinor, currency: order.currency }
      }).catch(() => undefined);
    }
    return moved;
  }

  const next = lookup.status === "expired" ? PAYMENT_STATUS.EXPIRED
    : lookup.status === "cancelled" ? PAYMENT_STATUS.CANCELLED
    : lookup.status === "pending" ? PAYMENT_STATUS.PENDING
    : PAYMENT_STATUS.FAILED;

  return transition(orderId, next, {
    by: order.provider || "provider",
    patch: { providerStatus: lookup.status },
    detail: { reason: lookup.reason ?? null },
    now
  });
}

/** Begin checking. Entered when a webhook arrives, before anything is believed. */
export async function markVerifying(orderId, { reason = "notified", now = new Date() } = {}) {
  return transition(orderId, PAYMENT_STATUS.VERIFYING, { by: "system", detail: { reason }, now });
}

export async function cancelPaymentOrder(orderId, { reason = "cancelled by the user", now = new Date() } = {}) {
  return transition(orderId, PAYMENT_STATUS.CANCELLED, { by: "user", detail: { reason }, now });
}

// ── Webhook deduplication ───────────────────────────────────────────────────

/**
 * Remember a webhook so the same one cannot act twice.
 *
 * Keyed on the provider's own event id where there is one, and otherwise on a
 * hash of the raw body — because a provider that does not give its events ids
 * still must not be able to replay them, and the body is the only thing we have
 * that identifies the event rather than the delivery.
 *
 * Returns `{ first: false }` for a repeat, which the caller treats as success:
 * a provider retrying a delivery we already handled should get a 200, or it
 * will keep retrying forever.
 */
export async function recordWebhookEvent({
  provider,
  eventId = null,
  rawBody = "",
  orderId = null,
  now = new Date()
}) {
  const fingerprint = eventId
    ? provider + ":" + eventId
    : provider + ":sha256:" + createHash("sha256").update(rawBody).digest("hex");

  return transact(db => {
    const existing = db.paymentEvents.find(item => item.fingerprint === fingerprint);
    if (existing) {
      existing.deliveries = Number(existing.deliveries || 1) + 1;
      existing.lastSeenAt = now.toISOString();
      return { first: false, event: { ...existing } };
    }

    const event = {
      id: id("payev"),
      provider,
      eventId,
      fingerprint,
      orderId,
      deliveries: 1,
      receivedAt: now.toISOString(),
      lastSeenAt: now.toISOString()
    };
    db.paymentEvents.push(event);
    return { first: true, event };
  });
}

// ── Funding ─────────────────────────────────────────────────────────────────

/**
 * Turn a paid order into budget the task may spend.
 *
 * The one place external money becomes internal allowance, and it happens
 * exactly once per order: `fundingId` on the order is the guard, checked inside
 * the same transaction that writes the funding row. A second call is a no-op
 * rather than a second credit, because "the webhook arrived twice" must not
 * mean "the task got paid for twice".
 *
 * Funding RAISES a ceiling. It does not reserve, capture or release anything —
 * that is billing.js's job, and this deliberately does not duplicate it.
 */
export async function fundTaskFromPayment(orderId, { now = new Date() } = {}) {
  const result = await transact(db => {
    const order = db.paymentOrders.find(item => item.id === orderId);
    if (!order) throw new Error("Payment order not found: " + orderId);
    if (order.status !== PAYMENT_STATUS.PAID) {
      return { funded: false, reason: "not-paid", status: order.status };
    }
    if (order.fundingId) {
      return { funded: false, reason: "already-funded", fundingId: order.fundingId };
    }
    if (!order.taskId) {
      return { funded: false, reason: "no-task" };
    }

    const task = db.tasks.find(item => item.id === order.taskId);
    if (!task) return { funded: false, reason: "task-not-found" };

    const major = (order.paidAmountMinor ?? order.amountMinor) / 100;

    const funding = {
      id: id("fund"),
      tenantId: order.tenantId,
      taskId: order.taskId,
      paymentOrderId: order.id,
      amountMinor: order.paidAmountMinor ?? order.amountMinor,
      currency: order.currency,
      createdAt: now.toISOString()
    };
    db.fundingEntries.push(funding);

    // The ledger records the credit alongside every debit, so the account of
    // what came in and what went out is one account.
    db.billingLedger.push({
      id: id("bledger"),
      tenantId: order.tenantId,
      taskId: order.taskId,
      agentInstanceId: task.agentInstanceId ?? null,
      reservationId: null,
      provider: order.provider || "internal",
      category: "funding",
      amount: major,
      currency: order.currency,
      reason: "payment " + order.id,
      idempotencyKey: "funding:" + order.id,
      createdAt: now.toISOString()
    });

    const previousLimit = Number(task.maxBudget || 0);
    task.maxBudget = Number((previousLimit + major).toFixed(2));
    task.updatedAt = now.toISOString();

    // The agent spends against its own limit, so it has to move too — otherwise
    // the task is funded and the work still cannot afford to run.
    const agent = task.agentInstanceId
      ? db.agentInstances.find(item => item.id === task.agentInstanceId)
      : null;
    if (agent) {
      agent.budgetLimit = Number((Number(agent.budgetLimit || 0) + major).toFixed(2));
      agent.updatedAt = now.toISOString();
    }

    order.fundingId = funding.id;
    order.fundedAt = now.toISOString();
    order.updatedAt = now.toISOString();

    return {
      funded: true,
      funding,
      previousLimit,
      newLimit: task.maxBudget,
      agentLimit: agent?.budgetLimit ?? null
    };
  });

  if (result.funded) {
    await writeAudit({
      tenantId: result.funding.tenantId,
      action: "payment.funded_task",
      resourceType: "task",
      resourceId: result.funding.taskId,
      metadata: {
        paymentOrderId: orderId,
        amountMinor: result.funding.amountMinor,
        newLimit: result.newLimit
      }
    }).catch(() => undefined);
  }

  return result;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Compare what we think happened with what the provider says.
 *
 * Reports differences; changes nothing. Rewriting financial history to match a
 * report is how a discrepancy stops being visible without ever being resolved.
 */
export async function reconcilePayments({ tenantId = null, providerOrders = [] } = {}) {
  const db = await loadDb();
  const ours = db.paymentOrders.filter(order => !tenantId || order.tenantId === tenantId);
  const byProviderId = new Map(
    ours.filter(order => order.providerOrderId).map(order => [order.providerOrderId, order])
  );
  const seen = new Set();

  const mismatched = [];
  const missingLocally = [];
  const duplicates = [];

  for (const remote of providerOrders) {
    if (seen.has(remote.providerOrderId)) {
      duplicates.push(remote.providerOrderId);
      continue;
    }
    seen.add(remote.providerOrderId);

    const local = byProviderId.get(remote.providerOrderId);
    if (!local) {
      // The provider has an order we have no record of. Never created here, or
      // created and lost; either way it is not something to invent a row for.
      missingLocally.push(remote);
      continue;
    }

    const remotePaid = remote.status === "paid";
    const localPaid = local.status === PAYMENT_STATUS.PAID;
    const amountDiffers = remotePaid && Number(remote.amountMinor) !== Number(local.paidAmountMinor ?? local.amountMinor);

    if (remotePaid !== localPaid || amountDiffers) {
      mismatched.push({
        orderId: local.id,
        providerOrderId: remote.providerOrderId,
        localStatus: local.status,
        providerStatus: remote.status,
        localAmountMinor: local.paidAmountMinor ?? local.amountMinor,
        providerAmountMinor: remote.amountMinor ?? null
      });
    }
  }

  const missingRemotely = ours.filter(order =>
    order.providerOrderId && !seen.has(order.providerOrderId)
  ).map(order => ({ orderId: order.id, providerOrderId: order.providerOrderId, status: order.status }));

  const unfunded = ours.filter(order => order.status === PAYMENT_STATUS.PAID && !order.fundingId)
    .map(order => ({ orderId: order.id, amountMinor: order.amountMinor }));

  return {
    checked: providerOrders.length,
    mismatched,
    missingLocally,
    missingRemotely,
    duplicates,
    // Paid and never turned into budget. A silent one of these is a customer
    // who paid and got nothing.
    paidButNotFunded: unfunded,
    clean: mismatched.length === 0 && missingLocally.length === 0 &&
      missingRemotely.length === 0 && duplicates.length === 0 && unfunded.length === 0
  };
}
