import { loadDb, transact, id } from "./store.js";
import { writeAudit } from "./tenant-security.js";
import { reopenNode } from "./jev.js";

// What to do about a model call whose outcome nobody knows.
//
// A provider that stops answering after the request was sent leaves exactly one
// fact established: we do not know whether it did the work. Both of the obvious
// responses are wrong.
//
//   Retry it        The call may have been served and billed. A retry pays
//                   twice, and does so silently.
//   Treat it as
//   free           It may have been billed. A task that assumes otherwise
//                   quietly overspends its real ceiling.
//
// So the node fails, the reservation is captured — the pessimistic assumption,
// because being wrong in the other direction costs money nobody accounted for —
// and a durable record is written saying precisely what has to be settled. This
// file is that record and the operations that settle it.
//
// It is NOT a second ledger. Resolving a reconciliation moves no money on its
// own: reversing a capture is a finance action with its own authority, and
// inventing one here would be exactly the fake refund this codebase refuses to
// write elsewhere.

export const RECONCILIATION_STATUS = {
  PENDING: "pending",
  RESOLVED_COMPLETED: "resolved_completed",
  RESOLVED_NOT_COMPLETED: "resolved_not_completed",
  UNRESOLVABLE: "unresolvable"
};

/**
 * Record a model call whose outcome could not be determined.
 *
 * `idempotencyKey` is the same key the request carried. It is what makes a
 * provider-side lookup possible at all, and what lets a provider that honours
 * idempotency serve a retry from its own record rather than doing the work
 * again — so it is stored even when no provider here can use it yet.
 */
export async function recordUnknownModelOutcome({
  agentInstanceId,
  taskId,
  tenantId,
  node,
  provider,
  model,
  idempotencyKey,
  reservedMinor = 0,
  capturedMinor = 0,
  detail = null,
  now = new Date()
}) {
  const record = await transact(db => {
    const existing = db.modelReconciliations.find(
      item => item.nodeId === node.id && item.attempt === Number(node.attempt || 1)
    );
    // The same attempt discovered twice is the same unknown, not two of them.
    if (existing) return existing;

    const row = {
      id: id("mrec"),
      tenantId: tenantId ?? node.tenantId ?? null,
      taskId,
      agentInstanceId,
      graphId: node.graphId,
      nodeId: node.id,
      nodeKey: node.key,
      nodeKind: node.kind,
      attempt: Number(node.attempt || 1),
      provider,
      model,
      idempotencyKey,
      reservedMinor,
      capturedMinor,
      status: RECONCILIATION_STATUS.PENDING,
      detail,
      providerEvidence: null,
      resolvedBy: null,
      resolvedAt: null,
      note: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    db.modelReconciliations.push(row);
    return row;
  });

  await writeAudit({
    tenantId: record.tenantId,
    action: "model.outcome_unknown",
    resourceId: record.id,
    outcome: "failure",
    metadata: {
      nodeKey: node.key,
      provider,
      model,
      attempt: record.attempt,
      capturedMinor
    }
  }).catch(() => undefined);

  return record;
}

export async function pendingReconciliations({ agentInstanceId = null, tenantId = null } = {}) {
  const db = await loadDb();
  return db.modelReconciliations.filter(item =>
    item.status === RECONCILIATION_STATUS.PENDING &&
    (agentInstanceId ? item.agentInstanceId === agentInstanceId : true) &&
    (tenantId ? item.tenantId === tenantId : true)
  );
}

/**
 * Ask the provider what actually happened.
 *
 * An adapter that can answer implements `reconcile({ idempotencyKey, model })`
 * and returns `{ completed, usage, output }` or `{ completed: false }`. Most
 * cannot: neither OpenAI nor Anthropic exposes a general "did this request
 * succeed" lookup, and pretending otherwise would be the fabricated integration
 * this codebase refuses to write. When the adapter has no such method the
 * record is left PENDING and reported as unsupported, which is an honest answer
 * a person can act on — not an UNRESOLVABLE verdict invented on its behalf.
 */
export async function attemptProviderReconciliation({ recordId, registry, now = new Date() }) {
  const db = await loadDb();
  const record = db.modelReconciliations.find(item => item.id === recordId);
  if (!record) throw new Error("Unknown reconciliation record: " + recordId);
  if (record.status !== RECONCILIATION_STATUS.PENDING) {
    return { status: record.status, record, supported: true };
  }

  const adapter = registry?.get?.(record.provider) ?? null;
  if (!adapter || typeof adapter.reconcile !== "function") {
    return {
      status: RECONCILIATION_STATUS.PENDING,
      record,
      supported: false,
      reason: "The " + record.provider + " adapter cannot look up a past request; this needs a person."
    };
  }

  let evidence;
  try {
    evidence = await adapter.reconcile({
      idempotencyKey: record.idempotencyKey,
      model: record.model
    });
  } catch (error) {
    return {
      status: RECONCILIATION_STATUS.PENDING,
      record,
      supported: true,
      reason: "The provider lookup failed: " + (error.message || "unknown error")
    };
  }

  return resolveReconciliation({
    recordId,
    completed: Boolean(evidence?.completed),
    resolvedBy: "provider:" + record.provider,
    providerEvidence: evidence ?? null,
    note: "Resolved by a provider-side lookup.",
    now
  });
}

/**
 * Settle a reconciliation.
 *
 * `completed: true`  — the provider did the work and charged for it. The
 *                      capture stands and the node stays failed: what was lost
 *                      is the RESULT, not the money, and re-running it is a
 *                      decision with a price attached that a person makes.
 *
 * `completed: false` — the call never happened. The node is reopened for
 *                      another attempt, because retrying is now free of the
 *                      double-charge risk that stopped it.
 *
 * Neither branch moves money. The capture made on an unknown outcome was the
 * pessimistic assumption; reversing it when the assumption turns out wrong is a
 * finance operation with its own approval path, and it is recorded here for
 * that path to act on rather than performed here.
 */
export async function resolveReconciliation({
  recordId,
  completed,
  resolvedBy = "operator",
  providerEvidence = null,
  note = null,
  now = new Date()
}) {
  const db = await loadDb();
  const record = db.modelReconciliations.find(item => item.id === recordId);
  if (!record) throw new Error("Unknown reconciliation record: " + recordId);
  if (record.status !== RECONCILIATION_STATUS.PENDING) {
    return { status: record.status, record, alreadyResolved: true };
  }

  const status = completed
    ? RECONCILIATION_STATUS.RESOLVED_COMPLETED
    : RECONCILIATION_STATUS.RESOLVED_NOT_COMPLETED;

  let reopened = null;
  if (!completed) {
    // Safe now, and only now: the call provably did not reach the model.
    reopened = await reopenNode({
      nodeId: record.nodeId,
      reason: "model call reconciled as never executed",
      now
    });
  }

  const updated = await transact(state => {
    const row = state.modelReconciliations.find(item => item.id === recordId);
    row.status = status;
    row.resolvedBy = resolvedBy;
    row.resolvedAt = now.toISOString();
    row.providerEvidence = providerEvidence;
    row.note = note;
    row.updatedAt = now.toISOString();
    // The spend stands either way; when it should not, this is the amount a
    // finance reversal has to be for.
    row.reversalOwedMinor = completed ? 0 : Number(row.capturedMinor || 0);
    return row;
  });

  await writeAudit({
    tenantId: record.tenantId,
    action: "model.reconciliation.resolved",
    resourceId: recordId,
    outcome: "success",
    metadata: {
      status,
      resolvedBy,
      nodeKey: record.nodeKey,
      reopened: Boolean(reopened?.accepted),
      reversalOwedMinor: updated.reversalOwedMinor
    }
  }).catch(() => undefined);

  return { status, record: updated, reopened, supported: true };
}
