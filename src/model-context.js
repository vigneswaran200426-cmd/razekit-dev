import { readNumberEnv } from "./adapters/model-json.js";

// What a model node is allowed to see.
//
// The naive thing is to hand a model everything the agent has ever written and
// let the provider decide. That fails in two ways that are easy to miss and
// expensive to hit:
//
//   Cost     Context is charged per token on every call. A repair chain that
//            carries its whole history forward pays for the same transcript
//            five times over, and the graph's budget cannot prevent it because
//            by then the request has been sent.
//
//   Silence  Past the provider's window the call simply fails, and it fails at
//            the END of a long task when the history has grown — so the failure
//            arrives exactly when the most work would be lost.
//
// So context is COMPILED rather than accumulated: a fixed core that is never
// dropped, the outputs of the nodes this node actually depends on, and a
// whitelist of the blackboard keys that carry decisions. If that still exceeds
// the ceiling it is compacted in a defined order — noise first, evidence last —
// and what was dropped is reported rather than being lost quietly.
//
// The core is never compacted. A request that has been trimmed until it no
// longer states the requirements is not a cheaper request; it is a request for
// different work.

/** Blackboard keys a model node may see, longest-prefix wins. */
const CONTEXT_KEY_PREFIXES = [
  "architecture.plan",
  "execution.plan",
  "game.execution.plan",
  "execution.lastResult",
  "game.execution.lastResult",
  "review.result",
  "implementation.result",
  "verification.evidence",
  "verification.lastFailure",
  "requirements",
  "acceptance"
];

// Deliberately excluded rather than merely not listed: prose summaries of
// earlier model calls are the largest thing on the blackboard and the least
// load-bearing. The structured output of a dependency says the same thing in a
// form the next node can act on.
const EXCLUDED_KEY_PREFIXES = ["model.node.", "model.reconciliation."];

export function contextCharBudget() {
  // Characters, not tokens. Tokens need a tokenizer per provider, and the point
  // here is a ceiling that exists rather than one that is precise; the ratio is
  // stable enough that a character budget bounds the token count.
  return Math.max(2000, readNumberEnv("RAZEKIT_MODEL_CONTEXT_MAX_CHARS", 24000));
}

function sizeOf(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Circular or unserialisable: it cannot be sent either, so treat it as
    // unaffordable rather than pretending it is free.
    return Number.MAX_SAFE_INTEGER;
  }
}

function relevantKey(key) {
  if (EXCLUDED_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) return false;
  return CONTEXT_KEY_PREFIXES.some(prefix => key === prefix || key.startsWith(prefix + "."));
}

/**
 * Reduce one upstream node's output to the part a downstream node acts on.
 *
 * A review becomes its decision and its findings; a plan becomes its steps'
 * shape rather than their content. Everything here is lossy on purpose — it is
 * what is kept when the full output does not fit, not what is preferred.
 */
function summarizeStructured(structured) {
  if (!structured || typeof structured !== "object") return structured ?? null;

  const summary = {};
  if (structured.review) {
    summary.review = {
      decision: structured.review.decision,
      reason: truncate(structured.review.reason, 400),
      findings: (structured.review.findings || []).slice(0, 10).map(finding =>
        typeof finding === "string"
          ? truncate(finding, 200)
          : {
              severity: finding?.severity ?? null,
              detail: truncate(finding?.detail ?? finding?.summary ?? "", 200)
            }
      )
    };
  }
  if (structured.plan) {
    summary.plan = {
      id: structured.plan.id ?? null,
      version: structured.plan.version ?? null,
      steps: (structured.plan.steps || []).map(step => ({
        id: step.id,
        kind: step.kind,
        path: step.path ?? null
      }))
    };
  }
  if (structured.architecture) {
    summary.architecture = { summary: truncate(structured.architecture.summary, 600) };
  }
  if (structured.implementation) {
    summary.implementation = {
      status: structured.implementation.status ?? null,
      summary: truncate(structured.implementation.summary, 400),
      filesChanged: structured.implementation.filesChanged ?? null
    };
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function truncate(value, max) {
  if (typeof value !== "string") return value ?? null;
  return value.length <= max ? value : value.slice(0, max) + "…";
}

/**
 * Compile the context for one model node.
 *
 * Returns `{ context, compaction }`. `compaction` is a record of what had to be
 * given up, and it is returned rather than logged so the caller can put it on
 * the node — a task whose later calls are working from a trimmed view should be
 * able to show that, not have it inferred from a bad result.
 */
export function compileNodeContext({
  agent,
  task,
  node,
  graphNodes = [],
  blackboard = [],
  maxChars = contextCharBudget()
}) {
  // ── The core. Never compacted, never dropped. ─────────────────────────────
  const core = {
    task: {
      id: task?.id ?? null,
      type: task?.taskType ?? null,
      title: task?.title ?? null,
      request: task?.originalRequest ?? null,
      specification: task?.specification ?? null
    },
    agent: { id: agent?.id ?? null, type: agent?.agentType ?? null },
    node: {
      key: node.key,
      kind: node.kind,
      attempt: node.attempt,
      instruction: node.payload?.prompt ?? node.description ?? null
    },
    // Objective evidence is part of the core for the node that exists to read
    // it. Compacting a verification record out of a verification node's context
    // would leave it interpreting nothing.
    evidence: node.payload?.evidence ?? null
  };

  const dependencyKeys = new Set(node.dependsOn ?? []);
  const upstreamFull = graphNodes
    .filter(item => dependencyKeys.has(item.key) && item.output?.structured)
    .map(item => ({ key: item.key, kind: item.kind, structured: item.output.structured }));

  const entriesFull = blackboard
    .filter(entry => relevantKey(entry.key))
    .map(entry => ({ key: entry.key, value: entry.value }));

  const dropped = [];
  let upstream = upstreamFull;
  let entries = entriesFull;
  let summarized = false;

  const build = () => ({ ...core, upstream, blackboard: entries });

  // ── Compaction, cheapest loss first ───────────────────────────────────────
  if (sizeOf(build()) > maxChars) {
    // 1. Summarise upstream outputs. This keeps every dependency represented —
    //    losing one entirely would hide from a repair that a review happened.
    upstream = upstreamFull.map(item => ({
      key: item.key,
      kind: item.kind,
      structured: summarizeStructured(item.structured)
    }));
    summarized = true;
    dropped.push("upstream-detail");
  }

  if (sizeOf(build()) > maxChars) {
    // 2. Keep only the most recent blackboard entry per key prefix. Older
    //    values of the same key are superseded by definition.
    const seen = new Set();
    entries = [...entriesFull].reverse().filter(entry => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    }).reverse();
    dropped.push("superseded-blackboard-entries");
  }

  if (sizeOf(build()) > maxChars) {
    // 3. Drop blackboard entries from the back — the oldest decisions — until
    //    it fits. The dependencies' own outputs stay, because those are what
    //    this node was built to consume.
    while (entries.length > 0 && sizeOf(build()) > maxChars) {
      const removed = entries.shift();
      dropped.push("blackboard:" + removed.key);
    }
  }

  const finalSize = sizeOf(build());
  const compaction = {
    compacted: dropped.length > 0,
    summarized,
    dropped,
    chars: finalSize,
    maxChars,
    // Reported, never hidden: the core alone is over the ceiling, so this call
    // is being made knowing it may be refused. The alternative — trimming the
    // requirements — asks for different work and calls it the same task.
    overBudget: finalSize > maxChars
  };

  return { context: build(), compaction };
}
