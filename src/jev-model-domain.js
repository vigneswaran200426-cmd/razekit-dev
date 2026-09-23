import { MODEL_ROLES } from "./model-runtime.js";

// Model phases as graph nodes.
//
// Until now a model call was something the orchestrator did between graph
// transitions: it had no node, no lease, no reservation and no durable attempt
// history. The consequence was concrete rather than theoretical — spend was
// recorded AFTER the provider had already been paid, so the budget could only
// ever report an overrun, never prevent one.
//
// A model node is an ordinary JEV node. It claims, leases, retries, propagates
// failure, cancels and audits exactly like a file write does. What it does
// differently lives in jev-model-executor.js; what it IS lives here.

export const MODEL_NODE_KINDS = {
  MODEL_ANALYSIS: "model_analysis",
  MODEL_PLAN: "model_plan",
  MODEL_IMPLEMENT: "model_implement",
  MODEL_REVIEW: "model_review",
  MODEL_REPAIR: "model_repair",
  MODEL_VERIFY: "model_verify",
  MODEL_REPLAN: "model_replan"
};

const MODEL_KIND_SET = new Set(Object.values(MODEL_NODE_KINDS));

export function isModelNodeKind(kind) {
  return MODEL_KIND_SET.has(kind);
}

// The agent a node's work belongs to. The node's KIND says what operation it
// is; the payload's AGENT says who performs it. Keeping them apart is what
// allows a planner to be swapped for a different provider without inventing a
// new node kind, which section 46 asks for.
export const MODEL_AGENTS = {
  ASTRA: "astra",
  FABLE: "fable"
};

/**
 * Which session role a model node needs.
 *
 * Repair is the implementer, not a third role: it is Fable doing the same job
 * with the review's findings added to its input. Giving it its own session
 * would split one model's history in two and lose the context a repair depends
 * on most.
 */
export function roleForModelKind(kind) {
  switch (kind) {
    case MODEL_NODE_KINDS.MODEL_PLAN:
    case MODEL_NODE_KINDS.MODEL_ANALYSIS:
    case MODEL_NODE_KINDS.MODEL_REPLAN:
      return MODEL_ROLES.PLANNER;
    case MODEL_NODE_KINDS.MODEL_IMPLEMENT:
    case MODEL_NODE_KINDS.MODEL_REPAIR:
      return MODEL_ROLES.IMPLEMENTER;
    case MODEL_NODE_KINDS.MODEL_REVIEW:
    case MODEL_NODE_KINDS.MODEL_VERIFY:
      return MODEL_ROLES.REVIEWER;
    default:
      throw new Error("Not a model node kind: " + kind);
  }
}

export function agentForModelKind(kind) {
  return roleForModelKind(kind) === MODEL_ROLES.IMPLEMENTER
    ? MODEL_AGENTS.FABLE
    : MODEL_AGENTS.ASTRA;
}

/** The instruction handed to the model for this node's operation. */
export function promptForModelKind(kind) {
  switch (kind) {
    case MODEL_NODE_KINDS.MODEL_ANALYSIS:
      return "Analyse the task requirements and identify dependencies, risks and what must be verified.";
    case MODEL_NODE_KINDS.MODEL_PLAN:
      return "Create or refine the execution plan. Produce concrete next implementation steps.";
    case MODEL_NODE_KINDS.MODEL_REPLAN:
      return "The previous plan did not survive execution. Produce a revised plan addressing what failed.";
    case MODEL_NODE_KINDS.MODEL_IMPLEMENT:
      return "Implement the current execution plan using the task workspace and approved tools.";
    case MODEL_NODE_KINDS.MODEL_REPAIR:
      return "Repair the implementation using the review findings. Change only what the findings require.";
    case MODEL_NODE_KINDS.MODEL_REVIEW:
      return "Review the implementation against the task and acceptance criteria. Decide pass, revise, or block.";
    case MODEL_NODE_KINDS.MODEL_VERIFY:
      return "Interpret the verification evidence. You may not assert a requirement passed without evidence for it.";
    default:
      throw new Error("Not a model node kind: " + kind);
  }
}

// ── Cost estimation ──────────────────────────────────────────────────────────

// What one call of each kind is expected to cost, in minor units, as a
// multiplier on the configured base. Planning and review are cheaper than
// implementation because they read and decide rather than write; repair sits
// between the two because it writes but against a narrower brief.
//
// These are ESTIMATES and the ceiling they produce is a reservation, not a
// price. The authoritative number is whatever usage the provider reports, which
// billing.js settles. Nothing here decides what anyone is charged.
const KIND_COST_WEIGHT = {
  [MODEL_NODE_KINDS.MODEL_ANALYSIS]: 0.6,
  [MODEL_NODE_KINDS.MODEL_PLAN]: 1,
  [MODEL_NODE_KINDS.MODEL_REPLAN]: 1,
  [MODEL_NODE_KINDS.MODEL_IMPLEMENT]: 4,
  [MODEL_NODE_KINDS.MODEL_REPAIR]: 2.5,
  [MODEL_NODE_KINDS.MODEL_REVIEW]: 0.8,
  [MODEL_NODE_KINDS.MODEL_VERIFY]: 0.5
};

/**
 * Estimate what a model node will cost, as a range.
 *
 * Returns minor units and a confidence, never a single number presented as
 * fact. A caller that wants one value should reserve `maximum` — a reservation
 * that is too small stops work that could have been afforded, and the excess is
 * released afterwards rather than charged.
 *
 * `confidence` is deliberately low: without provider pricing configured and
 * without history, this is an informed guess. Reporting it as certain is how an
 * estimate turns into a promise nobody can keep.
 */
export function estimateModelNodeCostMinor(kind, { baseMinor = 0, complexity = 1 } = {}) {
  const base = Math.max(0, Math.trunc(Number(baseMinor) || 0));
  if (base === 0) {
    return { minimumMinor: 0, expectedMinor: 0, maximumMinor: 0, confidence: 1, basis: "execution cost is configured as zero" };
  }

  const weight = KIND_COST_WEIGHT[kind] ?? 1;
  const scale = Math.max(0.25, Number(complexity) || 1);
  const expected = Math.round(base * weight * scale);

  return {
    minimumMinor: Math.round(expected * 0.5),
    expectedMinor: expected,
    // The ceiling carries the retry allowance: a node that fails once and
    // retries must not find its own second attempt unaffordable.
    maximumMinor: Math.round(expected * 1.8),
    confidence: 0.35,
    basis: "configured base cost, weighted by node kind"
  };
}

/**
 * What the provider says this call really cost, in minor units, or null when it
 * reported nothing.
 *
 * Null and zero are different answers and the settlement treats them
 * differently — "no measurement" is not "measured, and it was free".
 */
export function usageCostMinor(usage) {
  if (!usage) return null;
  if (usage.costMinor !== undefined && usage.costMinor !== null) {
    return Math.max(0, Math.trunc(Number(usage.costMinor) || 0));
  }
  if (usage.cost !== undefined && usage.cost !== null) {
    // billing.js works in whole currency units; the graph works in minor ones.
    return Math.max(0, Math.round(Number(usage.cost) * 100));
  }
  return null;
}

// ── Result contract ──────────────────────────────────────────────────────────

/**
 * The durable record a model node leaves behind.
 *
 * Deliberately excludes the raw prompt and the raw response body. Those are
 * large, they are the most likely place for a credential to appear, and the
 * downstream nodes consume the STRUCTURED fields — a plan, a decision, a set of
 * findings — never the prose. What is kept is what another node, an operator or
 * an auditor can actually act on.
 */
export function buildModelNodeResult({
  kind,
  agent,
  provider,
  model,
  attempt,
  status,
  structured = null,
  usage = null,
  costMinor = null,
  reservedMinor = 0,
  latencyMs = null,
  error = null
}) {
  return {
    kind,
    agent,
    provider,
    model,
    attempt,
    status,
    structured,
    usage: usage
      ? {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          cost: usage.cost ?? null
        }
      : null,
    costMinor,
    reservedMinor,
    latencyMs,
    error,
    recordedAt: new Date().toISOString()
  };
}

// ── Review contract ──────────────────────────────────────────────────────────

export const REVIEW_OUTCOMES = {
  PASS: "pass",
  REVISE: "revise",
  BLOCK: "block"
};

/**
 * Validate a review decision before it is allowed to branch the graph.
 *
 * Natural language must never steer execution directly. A review that does not
 * return one of the three known decisions is treated as REVISE rather than
 * PASS: an unreadable review is not evidence that the work is correct, and
 * defaulting the other way would let a malformed response complete a task.
 */
export function normalizeReviewResult(raw) {
  const decision = String(raw?.decision ?? "").toLowerCase();
  const known = Object.values(REVIEW_OUTCOMES).includes(decision);

  return {
    decision: known ? decision : REVIEW_OUTCOMES.REVISE,
    malformed: !known,
    reason: typeof raw?.reason === "string" ? raw.reason : (known ? "" : "The review did not return a usable decision."),
    findings: Array.isArray(raw?.findings) ? raw.findings : [],
    blockedOn: raw?.blockedOn ?? null,
    repairRequired: known ? decision === REVIEW_OUTCOMES.REVISE : true
  };
}
