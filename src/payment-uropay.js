import { PaymentGateway, GATEWAY_CAPABILITIES, hmacSignature, signaturesMatch } from "./payment-gateways.js";

// UroPay, behind the gateway boundary.
//
// What this adapter will NOT do is as important as what it will. UroPay's
// merchant capabilities for refunds and payouts are undocumented for this
// configuration, so they are absent from the capability set rather than
// implemented against a guessed endpoint. A refund call that silently does
// nothing is worse than one that refuses: the first tells a customer their
// money is coming back.
//
// Nothing here is VERIFIED. No credential exists, so no request has ever been
// sent. The shape of the requests is written from the documented order API; the
// contract tests below it exercise signing, verification, translation and
// deduplication, which are the parts that can be proven without a merchant
// account — and which are the parts that get payment systems compromised.

const DEFAULT_BASE_URL = "https://api.uropay.in";

/**
 * How UroPay names things, mapped to how RazeKit names things.
 *
 * One-way on purpose. RazeKit's statuses are RazeKit's, and letting a
 * provider's vocabulary reach the rest of the system is how swapping providers
 * becomes a rewrite.
 */
const STATUS_MAP = {
  created: "pending",
  pending: "pending",
  attempted: "pending",
  paid: "paid",
  success: "paid",
  captured: "paid",
  failed: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  expired: "expired"
};

export function translateUroPayStatus(raw) {
  const key = String(raw ?? "").toLowerCase();
  // An unrecognised status is UNKNOWN, never FAILED. A provider that invents a
  // status we have not seen has not told us the payment failed — it has told us
  // something we do not understand, and those are different.
  return STATUS_MAP[key] ?? "unknown";
}

export class UroPayGateway extends PaymentGateway {
  constructor({
    apiKey = process.env.UROPAY_API_KEY,
    apiSecret = process.env.UROPAY_API_SECRET,
    webhookSecret = process.env.UROPAY_WEBHOOK_SECRET,
    baseUrl = process.env.UROPAY_BASE_URL || DEFAULT_BASE_URL,
    environment = process.env.UROPAY_ENVIRONMENT || "test",
    timeoutMs = 20_000,
    fetchImpl = globalThis.fetch
  } = {}) {
    super({
      name: "uropay",
      environment,
      // Refund and payout are deliberately absent. See the note above.
      capabilities: [
        GATEWAY_CAPABILITIES.CREATE_ORDER,
        GATEWAY_CAPABILITIES.LOOKUP_ORDER,
        GATEWAY_CAPABILITIES.VERIFY_WEBHOOK,
        GATEWAY_CAPABILITIES.TRANSACTION_REPORT
      ]
    });
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.webhookSecret = webhookSecret;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /** Whether this adapter could actually talk to UroPay right now. */
  isConfigured() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  assertConfigured() {
    if (!this.isConfigured()) {
      throw new Error(
        "UroPay is not configured. Set UROPAY_API_KEY and UROPAY_API_SECRET; " +
        "no request has been attempted."
      );
    }
  }

  /**
   * Sign a request.
   *
   * The signature covers the method, the path, the timestamp and the body. A
   * signature over the body alone can be replayed against a different endpoint;
   * one without a timestamp can be replayed forever.
   */
  signRequest({ method, path, body, timestamp }) {
    const payload = [method.toUpperCase(), path, timestamp, body ?? ""].join("\n");
    return hmacSignature(this.apiSecret, payload);
  }

  async request(method, path, body = null) {
    this.assertConfigured();
    const timestamp = String(Date.now());
    const serialized = body === null ? "" : JSON.stringify(body);
    const signature = this.signRequest({ method, path, body: serialized, timestamp });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let transmitted = false;

    try {
      transmitted = true;
      const response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-uropay-key": this.apiKey,
          "x-uropay-timestamp": timestamp,
          "x-uropay-signature": signature
        },
        body: serialized || undefined,
        signal: controller.signal
      });

      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = new Error(
          "UroPay responded " + response.status + (payload?.message ? ": " + payload.message : "")
        );
        error.status = response.status;
        // 5xx and 429 may succeed on a retry; 4xx will not.
        error.retryable = response.status >= 500 || response.status === 429;
        error.transmitted = true;
        throw error;
      }

      return payload;
    } catch (error) {
      // The flag the reconciliation path reads. A request that never left is
      // safe to retry; one that did may have been acted on.
      if (error.transmitted === undefined) error.transmitted = transmitted;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async createOrder({ orderId, amountMinor, currency = "INR", customer = {}, metadata = {} }) {
    this.require(GATEWAY_CAPABILITIES.CREATE_ORDER);
    const response = await this.request("POST", "/v1/orders", {
      // Our id travels with the order, so a lookup by either side matches.
      reference: orderId,
      amount: amountMinor,
      currency,
      customer,
      notes: metadata
    });

    return {
      providerOrderId: response?.id ?? response?.order_id ?? null,
      status: translateUroPayStatus(response?.status),
      checkoutUrl: response?.checkout_url ?? response?.short_url ?? null,
      raw: response
    };
  }

  /**
   * What UroPay says about an order.
   *
   * This — not the webhook — is authoritative. A transport failure returns
   * `unknown` rather than throwing, because the caller's job is to record that
   * the answer could not be obtained, and an exception would be indistinguishable
   * from the order not existing.
   */
  async getOrder(providerOrderId) {
    this.require(GATEWAY_CAPABILITIES.LOOKUP_ORDER);
    try {
      const response = await this.request("GET", "/v1/orders/" + encodeURIComponent(providerOrderId));
      return {
        providerOrderId,
        status: translateUroPayStatus(response?.status),
        amountMinor: Number(response?.amount_paid ?? response?.amount ?? 0) || null,
        raw: response
      };
    } catch (error) {
      return {
        providerOrderId,
        status: "unknown",
        reason: error.message,
        transmitted: error.transmitted !== false
      };
    }
  }

  /**
   * Is this webhook really from UroPay, and is it recent?
   *
   * Both halves matter. A valid signature on a request captured an hour ago is
   * still a valid signature, so a timestamp outside the tolerance is rejected
   * even when the signature checks out.
   */
  verifyWebhook({ rawBody, signature, timestamp, toleranceMs = 5 * 60_000, now = Date.now() }) {
    this.require(GATEWAY_CAPABILITIES.VERIFY_WEBHOOK);
    if (!this.webhookSecret) {
      return { valid: false, reason: "UROPAY_WEBHOOK_SECRET is not configured" };
    }
    if (!signature) return { valid: false, reason: "missing signature" };

    const stamp = Number(timestamp);
    if (!Number.isFinite(stamp)) return { valid: false, reason: "missing or invalid timestamp" };
    if (Math.abs(now - stamp) > toleranceMs) {
      return { valid: false, reason: "timestamp outside the accepted window" };
    }

    const expected = hmacSignature(this.webhookSecret, timestamp + "\n" + rawBody);
    if (!signaturesMatch(expected, signature)) {
      return { valid: false, reason: "signature does not match" };
    }

    return { valid: true };
  }

  /**
   * What a webhook body means, without believing any of it.
   *
   * Only the identifiers are taken. The status and the amount are ignored on
   * purpose: they are what an attacker would forge, and they are exactly what a
   * lookup is about to tell us authoritatively.
   */
  parseWebhook(body) {
    const payload = typeof body === "string" ? JSON.parse(body) : body;
    return {
      eventId: payload?.event_id ?? payload?.id ?? null,
      providerOrderId: payload?.order_id ?? payload?.payload?.order?.id ?? null,
      reference: payload?.reference ?? payload?.payload?.order?.reference ?? null,
      // Recorded for the audit trail, never acted on.
      claimedStatus: translateUroPayStatus(payload?.status ?? payload?.event)
    };
  }

  async transactionReport({ from, to }) {
    this.require(GATEWAY_CAPABILITIES.TRANSACTION_REPORT);
    const response = await this.request(
      "GET",
      "/v1/reports/transactions?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to)
    );
    return (response?.items ?? []).map(item => ({
      providerOrderId: item.order_id,
      status: translateUroPayStatus(item.status),
      amountMinor: Number(item.amount) || 0,
      at: item.created_at
    }));
  }
}
