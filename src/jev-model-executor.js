import { transact } from "./store.js";
import { callModel, ModelRuntimeError } from "./model-runtime.js";
import { listModelSessions, provisionModelSessions, updateModelSession, appendModelMessage, recordModelUsage } from "./model-sessions.js";
import { reserveNodeBudget, releaseNodeBudget, settleNodeSpend } from "./jev-budget.js";
import { writeBlackboard } from "./blackboard.js";
import { compileNodeContext } from "./model-context.js";
import { recordUnknownModelOutcome } from "./model-reconciliation.js";
import {
  MODEL_NODE_KINDS,
  agentForModelKind,
  buildModelNodeResult,
  normalizeReviewResult,
  promptForModelKind,
  roleForModelKind,
  usageCostMinor
} from "./jev-model-domain.js";
import { MODEL_ROLES } from "./model-runtime.js";

// Executing a model node.
//
// The order of operations in here is the entire point of this file, and it is
// the reverse of what the orchestrator used to do.
//
//   BEFORE:  call the provider -> recordSpend() -> discover the budget was
//            exceeded -> block the task. The money was already spent. The
//            budget could report an overrun; it could never prevent one.
//
//   NOW:     reserve -> call the provider -> capture what was actually used ->
//            release the rest. A node that cannot be afforded never reaches the
//            provider at all.
//
// Everything else — lease fencing, retry classification, failure propagation,
// cancellation, audit — is inherited from JEV rather than reimplemented. There
// is no model scheduler, no model retry framework and no model ledger here.

/**
 * A model call whose outcome is genuinely unknown.
 *
 * A timeout after the request was transmitted is NOT a failure: the provider
 * may have completed the work and billed for it. Retrying such a call spends
 * the money twice, so it is classified separately and is never automatically
 * retried — the node fails for a human to reconcile, which is cheaper than
 * paying twice and much cheaper than doing so silently.
 */
export class ModelOutcomeUnknownError extends Error {
  constructor(message, { provider, model, attempt } = {}) {
    super(message);
    this.name = "ModelOutcomeUnknownError";
    this.provider = provider;
    this.model = model;
    this.attempt = attempt;
    this.retryable = false;
    this.outcomeUnknown = true;
  }
}

function isTransmitted(error) {
  // A request that never left is safe to retry; one that did may have been
  // served. `transmitted` is set by the adapter, which is the only layer that
  // knows. Absent the flag we assume the worse case.
  if (error?.transmitted === false) return false;
  return Boolean(error?.transmitted) || /timeout|timed out|ETIMEDOUT|socket hang up/i.test(error?.message || "");
}

/**
 * Pick the model session this node's work belongs to.
 *
 * Repair shares the implementer's session deliberately — see roleForModelKind.
 */
function sessionForRole(sessions, role) {
  if (role === MODEL_ROLES.IMPLEMENTER) return sessions.find(s => s.role === "implementer");
  return sessions.find(s => s.role === "planner_reviewer");
}

/**
 * Run one model node.
 *
 * Returns the same `{ output, failure }` shape the workspace runtimes produce,
 * so jev-executor settles it through exactly the same path. The differences are
 * contained here.
 */
export async function executeModelNode({
  node,
  agent,
  registry,
  context,
  profile,
  now = new Date()
}) {
  const kind = node.kind;
  const role = roleForModelKind(kind);
  const modelAgent = agentForModelKind(kind);

  // Provision on demand rather than relying on the orchestrator having run
  // first. A model node has to be self-sufficient: after a worker restart the
  // node is claimed directly from the graph, and nothing guarantees that
  // whatever used to set up the sessions ran in this process.
  // provisionModelSessions re-checks inside its own transaction, so two workers
  // racing here still produce one set of sessions.
  let sessions = await listModelSessions(agent.id);
  let session = sessionForRole(sessions, role);
  if (!session) {
    sessions = await provisionModelSessions(agent);
    session = sessionForRole(sessions, role);
  }
  if (!session) throw new Error("Required model session is not provisioned for role: " + role);

  // ── Reserve BEFORE the provider is touched ────────────────────────────────
  //
  // This is the ordering the whole phase exists to establish. A node that
  // cannot be afforded returns without a provider call having happened.
  const hold = await reserveNodeBudget({ node, agentInstanceId: agent.id });
  if (!hold.reserved) {
    await updateModelSession(session.id, { state: "budget_blocked", lastError: hold.reason });
    return {
      budgetRefused: true,
      reason: hold.reason,
      limit: hold.limit,
      reservedMinor: 0
    };
  }

  const prompt = node.payload?.prompt || promptForModelKind(kind);

  // The same key the budget reservation uses, and for the same reason: it
  // identifies THIS attempt at THIS node. A provider that honours idempotency
  // serves a repeat of it from its own record instead of doing — and charging
  // for — the work twice, and it is the handle a reconciliation lookup needs.
  const idempotencyKey = "jev:" + node.id + ":attempt:" + Number(node.attempt || 1);

  const request = {
    provider: session.provider,
    model: session.model,
    role,
    system: "You are part of an isolated autonomous development agent. Do not assume access to resources outside the task.",
    prompt,
    context,
    idempotencyKey
  };

  await updateModelSession(session.id, { state: "running", lastError: null });
  await appendModelMessage(session.id, "user", prompt, {
    nodeId: node.id,
    graphId: node.graphId,
    kind,
    attempt: node.attempt
  });

  let response = null;
  let failure = null;

  try {
    response = await callModel(registry, request);
  } catch (error) {
    failure = isTransmitted(error)
      ? new ModelOutcomeUnknownError(
          "The provider did not answer after the request was sent; the call may have completed and been billed.",
          { provider: session.provider, model: session.model, attempt: node.attempt }
        )
      : error;
  }

  // ── Settle, whichever way it went ─────────────────────────────────────────
  //
  // Asymmetric on purpose, and the asymmetry differs from a workspace node
  // because a model call costs real money at a third party:
  //
  //   succeeded  capture what the provider reported; fall back to the
  //              reservation when it reported nothing, because an unmeasured
  //              call is not a free one.
  //   failed     release in full — the provider rejected the request and there
  //              is nothing to pay for.
  //   unknown    capture the reservation. The call may have been served and
  //              billed, and treating a possible charge as free is how a task
  //              quietly overspends its real ceiling.
  const measured = usageCostMinor(response?.usage);
  let settledMinor = 0;
  let unrecordedMinor = 0;
  try {
    if (failure?.outcomeUnknown) {
      // Settle at the reservation, not at a measurement we never received.
      const settled = await settleNodeSpend({
        reservation: hold.reservation, agentInstanceId: agent.id,
        measuredMinor: hold.amountMinor, reason: "model node " + node.key
      });
      settledMinor = settled.capturedMinor;
    } else if (failure) {
      await releaseNodeBudget({ reservation: hold.reservation });
    } else {
      const settled = await settleNodeSpend({
        reservation: hold.reservation, agentInstanceId: agent.id,
        measuredMinor: measured, reason: "model node " + node.key
      });
      settledMinor = settled.capturedMinor;
      unrecordedMinor = settled.unrecordedMinor;
    }
  } catch (settlementError) {
    // Settlement must never mask the outcome of the call. The reservation is
    // visible in the ledger either way, and a stuck one is an operator problem
    // rather than a reason to lose the result.
    await writeBlackboard(
      agent.id,
      profile.keys.lastResult + ".settlementError",
      { nodeKey: node.key, error: settlementError.message },
      "jev-model-executor"
    );
  }

  if (failure?.outcomeUnknown) {
    // Durable, because the whole point is that it outlives this process. The
    // blackboard entry the loop writes is for the user; this is the record a
    // person or a provider lookup settles.
    await recordUnknownModelOutcome({
      agentInstanceId: agent.id,
      taskId: agent.taskId,
      tenantId: node.tenantId,
      node,
      provider: session.provider,
      model: session.model,
      idempotencyKey,
      reservedMinor: hold.amountMinor,
      capturedMinor: settledMinor,
      detail: { message: failure.message, role, kind }
    });
  }

  if (failure) {
    await updateModelSession(session.id, {
      state: failure.outcomeUnknown ? "outcome_unknown"
        : (failure instanceof ModelRuntimeError && failure.retryable) ? "retryable_error" : "failed",
      lastError: failure.message
    });
    failure.modelNodeResult = buildModelNodeResult({
      kind, agent: modelAgent, provider: session.provider, model: session.model,
      attempt: node.attempt, status: failure.outcomeUnknown ? "unknown" : "failed",
      reservedMinor: hold.amountMinor, costMinor: settledMinor, error: failure.message
    });
    throw failure;
  }

  if (unrecordedMinor > 0) {
    // The provider charged more than this task's budget can account for. The
    // node itself succeeded — the answer is real and is kept, because throwing
    // it away would mean paying again for the same work — but the task must
    // stop here rather than start another paid call it cannot afford.
    await writeBlackboard(
      agent.id,
      profile.keys.lastResult + ".unrecordedSpend",
      { nodeKey: node.key, unrecordedMinor, at: new Date().toISOString() },
      "jev-model-executor"
    );
  }

  await recordModelUsage(session.id, response.usage || {});
  if (response.output || response.text) {
    await appendModelMessage(session.id, "assistant", String(response.output || response.text), {
      nodeId: node.id, kind, model: session.model
    });
  }
  await updateModelSession(session.id, { state: "ready", lastError: null });

  // ── Structured output, stored where the next node reads it ────────────────
  const structured = structuredOutputFor(kind, response);
  await persistModelOutput({ agent, node, kind, profile, response, structured });

  return {
    operation: kind,
    ...buildModelNodeResult({
      kind, agent: modelAgent, provider: session.provider, model: session.model,
      attempt: node.attempt, status: "succeeded", structured,
      usage: response.usage, costMinor: settledMinor, reservedMinor: hold.amountMinor,
      latencyMs: response.latencyMs ?? null
    }),
    // Read by the loop: the work is kept, the task stops.
    budgetOverrun: unrecordedMinor > 0 ? { unrecordedMinor, nodeKey: node.key } : null,
    // jev-executor reads this to settle; it is already settled here, so the
    // measured value is reported to keep the two consistent rather than letting
    // the generic path capture a second time.
    usage: { costMinor: 0 }
  };
}

/**
 * The part of a model response downstream nodes actually consume.
 *
 * A review is normalised before it is stored, so a malformed decision cannot
 * reach the code that branches the graph.
 */
function structuredOutputFor(kind, response) {
  switch (kind) {
    case MODEL_NODE_KINDS.MODEL_PLAN:
    case MODEL_NODE_KINDS.MODEL_REPLAN:
    case MODEL_NODE_KINDS.MODEL_ANALYSIS:
      return { architecture: response.architecture ?? null, plan: response.plan ?? null };
    case MODEL_NODE_KINDS.MODEL_IMPLEMENT:
    case MODEL_NODE_KINDS.MODEL_REPAIR:
      return { implementation: response.implementation ?? null, plan: response.plan ?? null };
    case MODEL_NODE_KINDS.MODEL_REVIEW:
    case MODEL_NODE_KINDS.MODEL_VERIFY:
      return { review: normalizeReviewResult(response.review) };
    default:
      return null;
  }
}

/**
 * Store a model node's output under the keys the rest of the system reads.
 *
 * Uses the profile's keys rather than App/Web's, which is the bug the Konami
 * phase surfaced three times over. Nothing here hardcodes `execution.plan`.
 */
async function persistModelOutput({ agent, node, kind, profile, response, structured }) {
  const source = "jev:" + node.key;

  if (structured?.architecture) {
    await writeBlackboard(agent.id, "architecture.plan", structured.architecture, source);
  }
  if (structured?.plan) {
    await writeBlackboard(agent.id, profile.keys.plan, structured.plan, source);
  }
  if (structured?.implementation) {
    await writeBlackboard(agent.id, "implementation.result", structured.implementation, source);
  }
  if (structured?.review) {
    await writeBlackboard(agent.id, "review.result", structured.review, source);
  }
  if (response.output || response.text) {
    await writeBlackboard(
      agent.id,
      "model.node." + node.key + ".summary",
      String(response.output || response.text).slice(0, 2000),
      source
    );
  }
}

/**
 * The context a model node is given.
 *
 * Explicit references, not the whole conversation, and bounded: a node receives
 * the task, its own instruction, the structured outputs of the nodes it depends
 * on, and the blackboard keys that carry decisions — compiled to a ceiling by
 * model-context.js rather than accumulated until a provider refuses it.
 *
 * The compaction record travels with the result rather than being logged, so a
 * task whose later calls worked from a trimmed view can show that.
 */
export async function compileModelContext({ agent, task, node, graphNodes, blackboard }) {
  const { context, compaction } = compileNodeContext({
    agent, task, node, graphNodes: graphNodes ?? [], blackboard: blackboard ?? []
  });
  return { ...context, compaction };
}


/**
 * Record a model node transition on the run, so the Control Center and the
 * audit trail see model work as execution rather than as a gap between phases.
 */
export async function recordModelPhaseEvent({ agentInstanceId, taskId, node, status, detail = {} }) {
  return transact(db => {
    db.observabilityEvents.push({
      id: "mev_" + node.id + "_" + node.attempt + "_" + status,
      tenantId: node.tenantId,
      taskId,
      agentInstanceId,
      graphId: node.graphId,
      nodeId: node.id,
      kind: "model_phase",
      nodeKind: node.kind,
      status,
      detail,
      createdAt: new Date().toISOString()
    });
  }).catch(() => undefined);
}
