import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// The boundary every payment provider sits behind.
//
// The point of the boundary is that nothing outside it knows which provider is
// configured. A `if (provider === "uropay")` anywhere in the task, billing or
// graph code would mean swapping providers is a rewrite, and — worse — that
// UroPay's particular vocabulary of statuses becomes RazeKit's vocabulary. It
// is not. RazeKit has its own statuses, and an adapter's job is to translate.
//
// Capabilities are declared rather than assumed. A provider that does not
// support refunds says so, and the code that would have refunded asks a person
// instead of calling an endpoint that was guessed at. Assuming an undocumented
// capability is how a payment system acquires a feature that silently does
// nothing.

export const GATEWAY_CAPABILITIES = {
  CREATE_ORDER: "createOrder",
  LOOKUP_ORDER: "getOrder",
  VERIFY_WEBHOOK: "verifyWebhook",
  TRANSACTION_REPORT: "transactionReport",
  SETTLEMENT_REPORT: "settlementReport",
  REFUND: "refund",
  PAYOUT: "payout"
};

/**
 * What every adapter must be able to answer.
 *
 * `supports()` is checked before a capability is used, never after it fails.
 * The difference matters: a provider that returns 404 for refunds and a
 * provider that has no refund API look identical at the call site, and only one
 * of them is a bug.
 */
export class PaymentGateway {
  constructor({ name, capabilities = [], environment = "test" }) {
    if (!name) throw new Error("A payment gateway requires a name");
    this.name = name;
    this.environment = environment;
    this.capabilities = new Set(capabilities);
  }

  supports(capability) {
    return this.capabilities.has(capability);
  }

  require(capability) {
    if (!this.supports(capability)) {
      throw new Error(
        this.name + " does not support " + capability + ". This has to be done by a person."
      );
    }
  }

  async createOrder() { throw new Error(this.name + " has not implemented createOrder"); }
  async getOrder() { throw new Error(this.name + " has not implemented getOrder"); }
  verifyWebhook() { throw new Error(this.name + " has not implemented verifyWebhook"); }
}

export class PaymentGatewayRegistry {
  constructor() {
    this.gateways = new Map();
  }

  register(gateway) {
    if (!(gateway instanceof PaymentGateway)) {
      throw new Error("A payment gateway must extend PaymentGateway");
    }
    this.gateways.set(gateway.name, gateway);
    return gateway;
  }

  get(name) {
    const gateway = this.gateways.get(name);
    if (!gateway) throw new Error("No payment gateway is configured named: " + name);
    return gateway;
  }

  has(name) {
    return this.gateways.has(name);
  }

  list() {
    return [...this.gateways.values()].map(gateway => ({
      name: gateway.name,
      environment: gateway.environment,
      capabilities: [...gateway.capabilities]
    }));
  }
}

export const paymentGateways = new PaymentGatewayRegistry();

/**
 * Compare two signatures without leaking how much of them matched.
 *
 * A plain `===` on a signature compares byte by byte and stops at the first
 * difference, so how long it takes reveals how much was right. That is enough
 * to forge a signature one byte at a time given enough attempts.
 */
export function signaturesMatch(expected, received) {
  const a = Buffer.from(String(expected ?? ""), "utf8");
  const b = Buffer.from(String(received ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hmacSignature(secret, payload, algorithm = "sha256") {
  return createHmac(algorithm, secret).update(payload).digest("hex");
}

/**
 * A gateway that does exactly what it is told, for tests and for a deployment
 * with no provider configured.
 *
 * Deliberately NOT a fake that always succeeds. Its whole value is that a test
 * can make it fail, go quiet, report a different amount, or return an unknown
 * status — the situations that actually break payment systems. A double that
 * only knows how to succeed proves nothing about a system whose hard parts are
 * all failures.
 */
export class DeterministicGateway extends PaymentGateway {
  constructor({
    name = "deterministic",
    secret = "deterministic-secret",
    environment = "test",
    capabilities = [
      GATEWAY_CAPABILITIES.CREATE_ORDER,
      GATEWAY_CAPABILITIES.LOOKUP_ORDER,
      GATEWAY_CAPABILITIES.VERIFY_WEBHOOK
    ]
  } = {}) {
    super({ name, capabilities, environment });
    this.secret = secret;
    this.orders = new Map();
    // Set by a test to decide what the next lookup reports.
    this.lookupOverride = null;
  }

  async createOrder({ orderId, amountMinor, currency, metadata = {} }) {
    this.require(GATEWAY_CAPABILITIES.CREATE_ORDER);
    const providerOrderId = "det_" + randomUUID().slice(0, 12);
    this.orders.set(providerOrderId, {
      providerOrderId, orderId, amountMinor, currency, status: "pending", metadata
    });
    return { providerOrderId, status: "pending", checkoutUrl: "https://example.invalid/pay/" + providerOrderId };
  }

  async getOrder(providerOrderId) {
    this.require(GATEWAY_CAPABILITIES.LOOKUP_ORDER);
    if (this.lookupOverride) return { providerOrderId, ...this.lookupOverride };
    const order = this.orders.get(providerOrderId);
    if (!order) return { providerOrderId, status: "unknown", reason: "no such order" };
    return { providerOrderId, status: order.status, amountMinor: order.amountMinor };
  }

  /** Test helper: what the provider will say happened. */
  settle(providerOrderId, { status = "paid", amountMinor = null } = {}) {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new Error("Unknown provider order: " + providerOrderId);
    order.status = status;
    if (amountMinor !== null) order.amountMinor = amountMinor;
    return order;
  }

  sign(payload) {
    return hmacSignature(this.secret, payload);
  }

  verifyWebhook({ rawBody, signature }) {
    this.require(GATEWAY_CAPABILITIES.VERIFY_WEBHOOK);
    return signaturesMatch(this.sign(rawBody), signature);
  }
}
