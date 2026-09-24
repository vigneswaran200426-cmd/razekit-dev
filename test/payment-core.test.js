import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Money coming in.
//
// Almost every test here is an attack or a failure, because those are the only
// interesting cases. A payment system that handles the happy path is not a
// payment system; the happy path is the part that would work by accident.
//
// The three properties being defended:
//
//   the amount is ours        a client cannot name its own price
//   a webhook is a hint       nothing reaches PAID except a provider lookup
//   unknown is a state        we never guess in either direction

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-pay-data-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_STORE = "json";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const {
  PAYMENT_STATUS,
  attachProviderOrder,
  canTransition,
  cancelPaymentOrder,
  createQuote,
  fundTaskFromPayment,
  getPaymentOrder,
  markVerifying,
  recordWebhookEvent,
  reconcilePayments,
  settleFromProviderLookup
} = await import("../src/payment-core.js");
const { DeterministicGateway, GATEWAY_CAPABILITIES, signaturesMatch } =
  await import("../src/payment-gateways.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask({ maxBudget = 10 } = {}) {
  seq += 1;
  const tenantId = "tenant-pay-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "pay-user",
    taskType: "website",
    title: "Payment " + seq,
    originalRequest: "Build it",
    specification: "Build it",
    requestedTools: ["filesystem"],
    estimatedBudget: 5,
    maxBudget,
    actualSpend: 0,
    currency: "INR",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes: [],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => db.tasks.push(task));
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

async function quotedOrder({ amountMinor = 65_000, taskId = null, tenantId = "tenant-pay-x" } = {}) {
  return createQuote({
    tenantId, userId: "pay-user", taskId,
    purpose: "task-budget", amountMinor, currency: "INR"
  });
}

// ── The amount is ours ───────────────────────────────────────────────────────

test("a quote fixes the amount server-side and a zero or negative one is refused", async () => {
  const order = await quotedOrder({ amountMinor: 65_000 });
  assert.equal(order.amountMinor, 65_000);
  assert.equal(order.status, PAYMENT_STATUS.QUOTED);
  // Minor units, integer. A float here is a rounding error waiting for a
  // currency with more than two decimal places.
  assert.equal(Number.isInteger(order.amountMinor), true);

  await assert.rejects(() => quotedOrder({ amountMinor: 0 }), /positive amount/i);
  await assert.rejects(() => quotedOrder({ amountMinor: -100 }), /positive amount/i);
  await assert.rejects(() => quotedOrder({ amountMinor: "lots" }), /positive amount/i);
});

test("a provider reporting less than was quoted is a discrepancy, not a payment", async () => {
  const order = await quotedOrder({ amountMinor: 65_000 });
  await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_1" });

  // The classic underpayment: the checkout said 650, the provider says 1.
  const settled = await settleFromProviderLookup(order.id, {
    status: "paid", amountMinor: 100, providerOrderId: "det_1"
  });

  assert.equal(settled.order.status, PAYMENT_STATUS.RECONCILIATION_REQUIRED);
  assert.notEqual(settled.order.status, PAYMENT_STATUS.PAID);
  const detail = settled.order.history[settled.order.history.length - 1].detail;
  assert.equal(detail.reason, "amount-mismatch");
  assert.equal(detail.expectedMinor, 65_000);
  assert.equal(detail.reportedMinor, 100);
});

test("paying more than was quoted is accepted, because the money is real", async () => {
  const order = await quotedOrder({ amountMinor: 65_000 });
  await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_over" });
  const settled = await settleFromProviderLookup(order.id, {
    status: "paid", amountMinor: 70_000, providerOrderId: "det_over"
  });

  assert.equal(settled.order.status, PAYMENT_STATUS.PAID);
  assert.equal(settled.order.paidAmountMinor, 70_000);
});

// ── A webhook is a hint ──────────────────────────────────────────────────────

test("a webhook cannot make an order paid by itself", async () => {
  const order = await quotedOrder();
  await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_2" });

  // This is everything a webhook does: it moves the order to VERIFYING.
  await markVerifying(order.id, { reason: "webhook" });
  const afterHint = await getPaymentOrder(order.id);
  assert.equal(afterHint.status, PAYMENT_STATUS.VERIFYING);
  assert.notEqual(afterHint.status, PAYMENT_STATUS.PAID);

  // Only the lookup settles it.
  await settleFromProviderLookup(order.id, { status: "paid", amountMinor: 65_000 });
  assert.equal((await getPaymentOrder(order.id)).status, PAYMENT_STATUS.PAID);
});

test("a forged signature is rejected, and comparison does not leak how close it was", () => {
  const gateway = new DeterministicGateway({ secret: "s3cr3t" });
  const body = JSON.stringify({ event: "order.paid", order_id: "det_3" });
  const real = gateway.sign(body);

  assert.equal(gateway.verifyWebhook({ rawBody: body, signature: real }), true);
  assert.equal(gateway.verifyWebhook({ rawBody: body, signature: "0".repeat(real.length) }), false);
  // A body changed after signing invalidates it, which is the whole point.
  assert.equal(
    gateway.verifyWebhook({ rawBody: body.replace("det_3", "det_4"), signature: real }),
    false
  );

  // Length-differing inputs return false without a byte comparison at all.
  assert.equal(signaturesMatch(real, real.slice(0, -1)), false);
  assert.equal(signaturesMatch(real, real), true);
});

test("the same webhook delivered twice acts once", async () => {
  const order = await quotedOrder();
  const body = JSON.stringify({ event_id: "evt_77", order_id: "det_5" });

  const first = await recordWebhookEvent({ provider: "uropay", eventId: "evt_77", rawBody: body, orderId: order.id });
  const second = await recordWebhookEvent({ provider: "uropay", eventId: "evt_77", rawBody: body, orderId: order.id });
  const third = await recordWebhookEvent({ provider: "uropay", eventId: "evt_77", rawBody: body, orderId: order.id });

  assert.equal(first.first, true);
  assert.equal(second.first, false);
  assert.equal(third.first, false);
  // The repeats are counted rather than discarded: a provider retrying forever
  // is a signal worth seeing.
  assert.equal(third.event.deliveries, 3);
});

test("a provider with no event ids still cannot replay an event", async () => {
  const body = JSON.stringify({ order_id: "det_6", status: "paid" });

  const first = await recordWebhookEvent({ provider: "nameless", rawBody: body });
  const replay = await recordWebhookEvent({ provider: "nameless", rawBody: body });
  // A different event from the same provider is a different event.
  const other = await recordWebhookEvent({ provider: "nameless", rawBody: body.replace("det_6", "det_7") });

  assert.equal(first.first, true);
  assert.equal(replay.first, false, "an identical body was accepted twice");
  assert.equal(other.first, true);
});

// ── Unknown is a state ───────────────────────────────────────────────────────

test("a provider that cannot be reached leaves the order for a person", async () => {
  const order = await quotedOrder();
  await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_8" });
  await markVerifying(order.id);

  const settled = await settleFromProviderLookup(order.id, { status: "unknown", reason: "timeout" });

  assert.equal(settled.order.status, PAYMENT_STATUS.RECONCILIATION_REQUIRED);
  // Neither guess was made: not paid, not failed.
  assert.notEqual(settled.order.status, PAYMENT_STATUS.PAID);
  assert.notEqual(settled.order.status, PAYMENT_STATUS.FAILED);
});

test("an unrecognised provider status is unknown, not failed", async () => {
  const { translateUroPayStatus } = await import("../src/payment-uropay.js");
  assert.equal(translateUroPayStatus("paid"), "paid");
  assert.equal(translateUroPayStatus("CAPTURED"), "paid");
  assert.equal(translateUroPayStatus("failed"), "failed");
  // A provider inventing a status has not told us the payment failed.
  assert.equal(translateUroPayStatus("quantum_superposition"), "unknown");
  assert.equal(translateUroPayStatus(undefined), "unknown");
});

// ── The state machine ────────────────────────────────────────────────────────

test("nothing returns from a settled payment", async () => {
  const order = await quotedOrder();
  await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_9" });
  await settleFromProviderLookup(order.id, { status: "paid", amountMinor: 65_000 });

  // Every route out of PAID is closed, including back to pending.
  for (const status of Object.values(PAYMENT_STATUS)) {
    if (status === PAYMENT_STATUS.PAID) continue;
    assert.equal(canTransition(PAYMENT_STATUS.PAID, status), false, "PAID -> " + status + " is reachable");
  }

  const again = await settleFromProviderLookup(order.id, { status: "failed" });
  assert.equal(again.order.status, PAYMENT_STATUS.PAID, "a settled payment was overwritten");
  assert.equal(again.changed, false);

  const cancelled = await cancelPaymentOrder(order.id);
  assert.equal(cancelled.refused, true);
});

test("asking for the status it already has is not an error", async () => {
  const order = await quotedOrder();
  await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_10" });
  const repeat = await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_10" });

  assert.equal(repeat.changed, false);
  assert.equal(repeat.refused, undefined);
  // And it leaves no second history entry, so a replayed delivery is invisible
  // beyond the deduplication record.
  const current = await getPaymentOrder(order.id);
  assert.equal(current.history.filter(entry => entry.status === PAYMENT_STATUS.PENDING).length, 1);
});

// ── Funding ──────────────────────────────────────────────────────────────────

test("a paid order funds the task once, and only once", async () => {
  const { task, agent, tenantId } = await makeTask({ maxBudget: 10 });
  const order = await createQuote({
    tenantId, userId: "pay-user", taskId: task.id,
    purpose: "task-budget", amountMinor: 65_000, currency: "INR"
  });
  await attachProviderOrder(order.id, { provider: "deterministic", providerOrderId: "det_11" });
  await settleFromProviderLookup(order.id, { status: "paid", amountMinor: 65_000 });

  const funded = await fundTaskFromPayment(order.id);
  assert.equal(funded.funded, true);
  assert.equal(funded.previousLimit, 10);
  assert.equal(funded.newLimit, 660);

  // The agent's own ceiling moves too, or the task is funded and the work
  // still cannot afford to run.
  assert.equal(funded.agentLimit, 660);

  // "The webhook arrived twice" must not mean "the task got paid for twice".
  const again = await fundTaskFromPayment(order.id);
  assert.equal(again.funded, false);
  assert.equal(again.reason, "already-funded");

  const db = await loadDb();
  assert.equal(db.fundingEntries.filter(item => item.paymentOrderId === order.id).length, 1);
  const credits = db.billingLedger.filter(item => item.idempotencyKey === "funding:" + order.id);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].category, "funding");
  assert.equal(Number(db.agentInstances.find(item => item.id === agent.id).budgetLimit), 660);
});

test("an unpaid order funds nothing", async () => {
  const { task, tenantId } = await makeTask({ maxBudget: 10 });
  const order = await createQuote({
    tenantId, userId: "pay-user", taskId: task.id,
    purpose: "task-budget", amountMinor: 65_000
  });

  const funded = await fundTaskFromPayment(order.id);
  assert.equal(funded.funded, false);
  assert.equal(funded.reason, "not-paid");

  const db = await loadDb();
  assert.equal(Number(db.tasks.find(item => item.id === task.id).maxBudget), 10);
  // Scoped to this order: earlier tests in this file funded theirs.
  assert.equal(db.fundingEntries.filter(item => item.paymentOrderId === order.id).length, 0);
});

// ── Reconciliation ───────────────────────────────────────────────────────────

test("reconciliation reports differences and changes nothing", async () => {
  const { task, tenantId } = await makeTask();
  const paid = await createQuote({ tenantId, taskId: task.id, purpose: "task-budget", amountMinor: 50_000 });
  await attachProviderOrder(paid.id, { provider: "deterministic", providerOrderId: "det_r1" });
  await settleFromProviderLookup(paid.id, { status: "paid", amountMinor: 50_000 });

  const stillPending = await createQuote({ tenantId, taskId: task.id, purpose: "task-budget", amountMinor: 20_000 });
  await attachProviderOrder(stillPending.id, { provider: "deterministic", providerOrderId: "det_r2" });

  const report = await reconcilePayments({
    tenantId,
    providerOrders: [
      // The provider says the second one was paid; we think it is pending.
      { providerOrderId: "det_r2", status: "paid", amountMinor: 20_000 },
      // An order the provider has and we have never seen.
      { providerOrderId: "det_ghost", status: "paid", amountMinor: 9_900 },
      // And a duplicate line in the report.
      { providerOrderId: "det_r2", status: "paid", amountMinor: 20_000 }
    ]
  });

  assert.equal(report.clean, false);
  assert.equal(report.mismatched.length, 1);
  assert.equal(report.mismatched[0].localStatus, PAYMENT_STATUS.PENDING);
  assert.equal(report.mismatched[0].providerStatus, "paid");
  assert.equal(report.missingLocally.length, 1);
  assert.equal(report.duplicates.length, 1);
  // The first order was paid and never funded — a customer who paid and got
  // nothing, which is the finding that matters most.
  assert.equal(report.paidButNotFunded.length, 1);
  assert.equal(report.missingRemotely.length, 1);
  assert.equal(report.missingRemotely[0].orderId, paid.id);

  // Nothing was rewritten to make the report clean.
  assert.equal((await getPaymentOrder(stillPending.id)).status, PAYMENT_STATUS.PENDING);
});

// ── Capabilities ─────────────────────────────────────────────────────────────

test("an undocumented capability refuses rather than guessing at an endpoint", async () => {
  const { UroPayGateway } = await import("../src/payment-uropay.js");
  const gateway = new UroPayGateway({ apiKey: "k", apiSecret: "s", webhookSecret: "w" });

  assert.equal(gateway.supports(GATEWAY_CAPABILITIES.CREATE_ORDER), true);
  assert.equal(gateway.supports(GATEWAY_CAPABILITIES.LOOKUP_ORDER), true);
  // Refunds and payouts are undocumented for this merchant configuration. An
  // adapter that implemented them against a guessed endpoint would tell a
  // customer their money is coming back.
  assert.equal(gateway.supports(GATEWAY_CAPABILITIES.REFUND), false);
  assert.equal(gateway.supports(GATEWAY_CAPABILITIES.PAYOUT), false);
  assert.throws(() => gateway.require(GATEWAY_CAPABILITIES.REFUND), /has to be done by a person/i);
});

test("an unconfigured gateway says so instead of attempting a request", async () => {
  const { UroPayGateway } = await import("../src/payment-uropay.js");
  const gateway = new UroPayGateway({ apiKey: undefined, apiSecret: undefined });

  assert.equal(gateway.isConfigured(), false);
  await assert.rejects(
    () => gateway.createOrder({ orderId: "x", amountMinor: 100 }),
    /not configured.*no request has been attempted/is
  );
});
