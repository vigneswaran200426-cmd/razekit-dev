import { id, loadDb, transact } from "./store.js";
import { getAgent } from "./agent-manager.js";
import { ensureTenant, tenantForTask, writeAudit } from "./tenant-security.js";

export class BillingAdapter {
  async quote() { throw new Error("BillingAdapter.quote() is not implemented"); }
  async authorize() { throw new Error("BillingAdapter.authorize() is not implemented"); }
  async capture() { throw new Error("BillingAdapter.capture() is not implemented"); }
  async refund() { throw new Error("BillingAdapter.refund() is not implemented"); }
}

export class DeterministicBillingAdapter extends BillingAdapter {
  async quote({ amount, currency = "USD" }) {
    return { approved: amount >= 0, amount, currency };
  }

  async authorize({ amount, currency = "USD", idempotencyKey }) {
    return { providerRef: "billref_" + idempotencyKey, amount, currency, status: "authorized" };
  }

  async capture({ providerRef, amount, currency = "USD" }) {
    return { providerRef, amount, currency, status: "captured" };
  }

  async refund({ providerRef, amount, currency = "USD" }) {
    return { providerRef, amount, currency, status: "refunded" };
  }
}

export class BillingRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(provider, adapter) {
    if (!provider?.trim()) throw new Error("Billing provider is required");
    if (!adapter || typeof adapter.authorize !== "function" || typeof adapter.capture !== "function") {
      throw new Error("Billing adapter is invalid");
    }
    this.adapters.set(provider, adapter);
  }

  get(provider) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error("No billing adapter configured for provider: " + provider);
    return adapter;
  }
}

export const billingRegistry = new BillingRegistry();

export async function reserveSpend(agentId, amount, reason, { idempotencyKey, category = "model", provider = "internal" } = {}) {
  const spend = Number(amount);
  if (!Number.isFinite(spend) || spend < 0) throw new Error("Spend amount must be a non-negative number");
  if (!idempotencyKey?.trim()) throw new Error("idempotencyKey is required");

  const agent = await getAgent(agentId);
  if (!agent) throw new Error("Agent instance not found");
  const tenantId = await tenantForTask(agent.taskId);
  const tenant = await ensureTenant(tenantId);

  const billingState = await loadDb();
  const recentSpend = billingState.billingLedger
    .filter(item => item.tenantId === tenantId && Date.parse(item.createdAt) >= Date.now() - 3_600_000)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const recentReserved = billingState.billingReservations
    .filter(item =>
      item.tenantId === tenantId &&
      item.status === "reserved" &&
      Date.parse(item.createdAt) >= Date.now() - 3_600_000
    )
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  if (recentSpend + recentReserved + spend > Number(tenant.limits?.spendPerHour ?? Infinity)) {
    throw new Error("Abuse limit exceeded: spendPerHour");
  }

  return transact(db => {
    const existing = db.billingReservations.find(item =>
      item.agentInstanceId === agentId && item.idempotencyKey === idempotencyKey
    );
    if (existing) return existing;

    const current = db.agentInstances.find(item => item.id === agentId);
    if (!current) throw new Error("Agent instance not found");

    const reserved = db.billingReservations
      .filter(item => item.agentInstanceId === agentId && item.status === "reserved")
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const next = Number(current.budgetUsed || 0) + reserved + spend;
    if (next > Number(current.budgetLimit)) throw new Error("Hard budget limit exceeded");

    const now = new Date().toISOString();
    const reservation = {
      id: id("bres"),
      tenantId,
      taskId: current.taskId,
      agentInstanceId: agentId,
      amount: spend,
      category,
      provider,
      reason,
      idempotencyKey,
      status: "reserved",
      createdAt: now,
      resolvedAt: null
    };
    db.billingReservations.push(reservation);
    return reservation;
  });
}

export async function captureSpend(reservationId) {
  return transact(db => {
    const reservation = db.billingReservations.find(item => item.id === reservationId);
    if (!reservation) throw new Error("Spend reservation not found");
    if (reservation.status === "captured") return reservation;
    if (reservation.status !== "reserved") throw new Error("Spend reservation is not capturable");

    const agent = db.agentInstances.find(item => item.id === reservation.agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");

    const competingReserved = db.billingReservations
      .filter(item => item.agentInstanceId === reservation.agentInstanceId && item.status === "reserved" && item.id !== reservation.id)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const nextSpend = Number(agent.budgetUsed || 0) + reservation.amount;
    if (nextSpend + competingReserved > Number(agent.budgetLimit)) throw new Error("Hard budget limit exceeded");

    agent.budgetUsed = nextSpend;
    const task = db.tasks.find(item => item.id === agent.taskId);
    if (task) {
      task.actualSpend = nextSpend;
      task.updatedAt = new Date().toISOString();
    }

    const now = new Date().toISOString();
    reservation.status = "captured";
    reservation.resolvedAt = now;

    db.billingLedger.push({
      id: id("bledger"),
      tenantId: reservation.tenantId,
      taskId: reservation.taskId,
      agentInstanceId: reservation.agentInstanceId,
      reservationId: reservation.id,
      provider: reservation.provider,
      category: reservation.category,
      amount: reservation.amount,
      currency: "USD",
      reason: reservation.reason,
      idempotencyKey: reservation.idempotencyKey,
      createdAt: now
    });

    db.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: "Spend captured: " + reservation.amount,
      metadata: { billingReservationId: reservation.id, category: reservation.category },
      createdAt: now
    });

    return reservation;
  }).then(async result => {
    await writeAudit({
      tenantId: result.tenantId,
      action: "billing.capture",
      resourceType: "billing-reservation",
      resourceId: result.id,
      metadata: {
        amount: result.amount,
        category: result.category,
        provider: result.provider,
        idempotencyKey: result.idempotencyKey
      }
    });
    return result;
  });
}

export async function releaseSpend(reservationId) {
  return transact(db => {
    const reservation = db.billingReservations.find(item => item.id === reservationId);
    if (!reservation) throw new Error("Spend reservation not found");
    if (reservation.status === "released") return reservation;
    if (reservation.status !== "reserved") throw new Error("Only reserved spend can be released");
    reservation.status = "released";
    reservation.resolvedAt = new Date().toISOString();
    return reservation;
  });
}

export async function chargeProvider({
  agentId,
  amount,
  reason,
  category = "provider",
  provider = "internal",
  idempotencyKey
}) {
  const registry = chargeProvider.registry || billingRegistry;
  const adapter = registry?.get(provider);
  if (!adapter) throw new Error("Billing provider is not configured");

  const reservation = await reserveSpend(agentId, amount, reason, {
    idempotencyKey,
    category,
    provider
  });

  if (reservation.status === "captured") {
    return { reservation, authorization: null, capture: null, idempotentReplay: true };
  }

  try {
    const authorization = await adapter.authorize({
      amount: reservation.amount,
      currency: "USD",
      idempotencyKey: reservation.idempotencyKey
    });
    const capture = await adapter.capture({
      providerRef: authorization.providerRef,
      amount: reservation.amount,
      currency: "USD"
    });
    await captureSpend(reservation.id);
    return { reservation, authorization, capture };
  } catch (error) {
    await releaseSpend(reservation.id);
    throw error;
  }
}
