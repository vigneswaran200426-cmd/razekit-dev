// JEV — the dependency model for a task's execution graph.
//
// Everything in this file is pure. It takes nodes, returns nodes, and touches
// no store, no clock it was not handed, and no worker. That is deliberate: the
// rules that decide "may this run yet" and "what dies when this dies" are the
// part that must be provable, and a pure function is the only kind you can
// prove cheaply. Persistence and leasing live in jev.js.
//
// A node is identified inside its graph by `key` — a slug the planner writes
// and a reviewer can read. `id` is the store's identifier. Dependencies are
// expressed between keys, never between store ids, so a graph survives being
// written, read back, and re-planned.

export const NODE_STATUS = {
  // Dependencies are not all satisfied yet. The resting state of a new node.
  PENDING: "pending",
  // Every dependency succeeded. Claimable by a worker.
  READY: "ready",
  // Claimed under a lease. Exactly one worker owns it.
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  // Ran and failed, with no attempts left or with a non-retryable error.
  FAILED: "failed",
  // Never ran and never will: something it depends on is not going to succeed.
  // Distinct from FAILED because this node did nothing wrong, and an operator
  // reading the graph needs to see the difference between the cause and the
  // casualties.
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
  // Exceeded its own deadline with no attempts left. Distinct from FAILED so
  // "it was too slow" is not indistinguishable from "it was broken".
  TIMED_OUT: "timed_out"
};

export const TERMINAL_STATUSES = new Set([
  NODE_STATUS.SUCCEEDED,
  NODE_STATUS.FAILED,
  NODE_STATUS.SKIPPED,
  NODE_STATUS.CANCELLED,
  NODE_STATUS.TIMED_OUT
]);

// Terminal and not successful. A dependent of any of these can never run.
export const DOOMED_STATUSES = new Set([
  NODE_STATUS.FAILED,
  NODE_STATUS.SKIPPED,
  NODE_STATUS.CANCELLED,
  NODE_STATUS.TIMED_OUT
]);

export const GRAPH_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled"
};

export function isTerminal(node) {
  return TERMINAL_STATUSES.has(node.status);
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Reject a graph that cannot be executed, before it is ever stored.
 *
 * The cycle check is the load-bearing one. A cycle does not announce itself at
 * runtime: every node in it waits forever for another node in it, the scheduler
 * finds nothing READY, and the task sits at "running" with no worker and no
 * error until a human notices. Catching it here turns a silent hang into a
 * rejected plan.
 */
export function assertGraphShape(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("An execution graph must contain at least one node");
  }

  const byKey = new Map();
  for (const node of nodes) {
    const key = String(node?.key || "").trim();
    if (!key) throw new Error("Every graph node requires a key");
    if (byKey.has(key)) throw new Error("Duplicate graph node key: " + key);
    byKey.set(key, node);
  }

  for (const node of nodes) {
    const deps = node.dependsOn ?? [];
    if (!Array.isArray(deps)) {
      throw new Error("dependsOn must be an array on node: " + node.key);
    }
    const seen = new Set();
    for (const dep of deps) {
      if (dep === node.key) {
        throw new Error("Node depends on itself: " + node.key);
      }
      if (!byKey.has(dep)) {
        throw new Error("Node " + node.key + " depends on unknown node: " + dep);
      }
      if (seen.has(dep)) {
        throw new Error("Node " + node.key + " lists duplicate dependency: " + dep);
      }
      seen.add(dep);
    }
  }

  assertAcyclic(nodes);
  return nodes;
}

/**
 * Kahn's algorithm. Whatever cannot be peeled off is, by definition, in a cycle
 * or downstream of one — and those keys are named in the error, because "your
 * graph has a cycle" is not a message anyone can act on.
 */
export function assertAcyclic(nodes) {
  const indegree = new Map();
  const dependents = new Map();

  for (const node of nodes) {
    indegree.set(node.key, (node.dependsOn ?? []).length);
    dependents.set(node.key, []);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      dependents.get(dep).push(node.key);
    }
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([key]) => key)
    .sort();

  let settled = 0;
  while (queue.length > 0) {
    const key = queue.shift();
    settled += 1;
    for (const next of dependents.get(key)) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (settled !== nodes.length) {
    const stuck = [...indegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([key]) => key)
      .sort();
    throw new Error("Execution graph contains a dependency cycle: " + stuck.join(", "));
  }

  return nodes;
}

/**
 * A deterministic execution order for a valid graph: topological, and within a
 * layer, by the order the planner wrote the nodes. Two runs of the same plan
 * schedule in the same sequence, which is what makes a failure reproducible.
 */
export function topologicalOrder(nodes) {
  assertGraphShape(nodes);
  const position = new Map(nodes.map((node, index) => [node.key, Number(node.order ?? index)]));
  const indegree = new Map(nodes.map(node => [node.key, (node.dependsOn ?? []).length]));
  const dependents = new Map(nodes.map(node => [node.key, []]));
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) dependents.get(dep).push(node.key);
  }

  const byPosition = (a, b) => position.get(a) - position.get(b) || (a < b ? -1 : a > b ? 1 : 0);
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k).sort(byPosition);
  const ordered = [];

  while (queue.length > 0) {
    const key = queue.shift();
    ordered.push(key);
    for (const next of dependents.get(key)) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        queue.sort(byPosition);
      }
    }
  }
  return ordered;
}

// ── Readiness and propagation ────────────────────────────────────────────────

/**
 * Bring every node's status in line with its dependencies, and keep doing it
 * until nothing changes.
 *
 * Two rules, applied to fixpoint:
 *
 *   PENDING  -> READY    when every dependency SUCCEEDED
 *   PENDING
 *   or READY -> SKIPPED  when any dependency is terminal-and-not-successful
 *
 * The fixpoint is what makes failure propagate transitively. One pass would
 * skip the direct dependents of a failure and leave THEIR dependents PENDING
 * forever — the same silent hang as a cycle, arrived at differently.
 *
 * RUNNING is never touched here. A node a worker currently holds is that
 * worker's to finish or to lose by lease expiry; reassigning it from underneath
 * is how the same work gets executed twice.
 *
 * Returns the nodes whose status this call changed, so the caller can audit
 * exactly what moved and why.
 */
export function applyReadiness(nodes) {
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const changed = [];

  let moved = true;
  while (moved) {
    moved = false;
    for (const node of nodes) {
      if (node.status !== NODE_STATUS.PENDING && node.status !== NODE_STATUS.READY) continue;

      const deps = (node.dependsOn ?? []).map(key => byKey.get(key));
      const doomed = deps.find(dep => DOOMED_STATUSES.has(dep.status));

      if (doomed) {
        const from = node.status;
        node.status = NODE_STATUS.SKIPPED;
        node.skippedBecause = doomed.key;
        changed.push({ key: node.key, from, to: node.status, because: doomed.key });
        moved = true;
        continue;
      }

      const satisfied = deps.every(dep => dep.status === NODE_STATUS.SUCCEEDED);
      if (satisfied && node.status === NODE_STATUS.PENDING) {
        node.status = NODE_STATUS.READY;
        changed.push({ key: node.key, from: NODE_STATUS.PENDING, to: node.status });
        moved = true;
      }
    }
  }

  return changed;
}

/**
 * The claimable nodes, in deterministic order.
 *
 * Readiness is re-derived here rather than trusted from the stored status. The
 * stored status is a cache; the dependencies are the truth. If the two ever
 * disagree — a partial write, a migration, a hand-edited row — this declines to
 * hand out the node rather than running work whose prerequisites did not pass.
 */
export function claimableNodes(nodes, { resourceClass = null } = {}) {
  const byKey = new Map(nodes.map(node => [node.key, node]));
  return nodes
    .filter(node => node.status === NODE_STATUS.READY)
    .filter(node => (node.dependsOn ?? []).every(key => byKey.get(key)?.status === NODE_STATUS.SUCCEEDED))
    .filter(node => (resourceClass ? (node.resourceClass || "cpu") === resourceClass : true))
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The graph's status, derived from its nodes rather than stored alongside them.
 *
 * Stored separately it becomes a second source of truth that drifts the first
 * time a transition is missed. Derived, it cannot disagree with the nodes.
 */
export function deriveGraphStatus(nodes) {
  if (nodes.length === 0) return GRAPH_STATUS.PENDING;
  if (nodes.every(node => node.status === NODE_STATUS.SUCCEEDED)) return GRAPH_STATUS.SUCCEEDED;

  if (nodes.every(isTerminal)) {
    // Every node has settled and at least one did not succeed. Cancellation is
    // reported ahead of failure: an operator who stopped the graph should be
    // told it stopped, not told it broke.
    return nodes.some(node => node.status === NODE_STATUS.CANCELLED)
      ? GRAPH_STATUS.CANCELLED
      : GRAPH_STATUS.FAILED;
  }

  const started = nodes.some(node =>
    node.status === NODE_STATUS.RUNNING || isTerminal(node) || Number(node.attempt || 0) > 0
  );
  return started ? GRAPH_STATUS.RUNNING : GRAPH_STATUS.PENDING;
}

// ── Tool scope ───────────────────────────────────────────────────────────────

/**
 * A node's declared scopes are written as `toolKey:scope`, where the scope part
 * may itself contain a colon — `filesystem:workspace:write`. Split on the first
 * colon only.
 */
export function parseToolScope(entry) {
  const text = String(entry || "");
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) {
    throw new Error("Malformed tool scope: " + text);
  }
  return { toolKey: text.slice(0, at), scope: text.slice(at + 1) };
}

/**
 * Decide whether a node may make this tool call.
 *
 * This NARROWS; it never widens. The agent's granted permissions remain the
 * outer boundary and are checked separately by the permission broker — a node
 * cannot reach a scope the agent was never given by declaring it here.
 *
 * Three cases, and the difference between the last two is deliberate:
 *
 *   toolScopes absent (null/undefined)  no narrowing. The node was created
 *                                       before scopes existed, or by a caller
 *                                       that declares none; the agent's own
 *                                       permissions still apply in full.
 *   toolScopes []                       explicitly no tools at all.
 *   toolScopes [...]                    only what is listed.
 *
 * Making "absent" mean "nothing" would look stricter and would in fact be
 * worse: every existing node would start failing, and the pressure would be to
 * hand nodes a blanket scope to get moving again.
 */
export function checkNodeToolScope(node, toolKey, requestedScopes = []) {
  const declared = node?.toolScopes;
  if (declared === null || declared === undefined) {
    return { allowed: true, narrowed: false, missing: [] };
  }
  if (!Array.isArray(declared)) {
    throw new Error("Node toolScopes must be an array when present");
  }

  const allowedForTool = new Set(
    declared
      .map(parseToolScope)
      .filter(entry => entry.toolKey === toolKey)
      .map(entry => entry.scope)
  );

  if (allowedForTool.size === 0) {
    return {
      allowed: false,
      narrowed: true,
      missing: requestedScopes.length ? [...requestedScopes] : ["*"],
      reason: "This step does not use the " + toolKey + " tool"
    };
  }

  // An empty request means "every scope this tool has", and the node cannot be
  // assumed to have declared all of them — so it is resolved by the caller
  // before it reaches here. Reaching here empty means the node's own scopes are
  // the request, which is trivially within itself.
  const missing = requestedScopes.filter(scope => !allowedForTool.has(scope));
  return {
    allowed: missing.length === 0,
    narrowed: true,
    missing,
    reason: missing.length ? "Step does not declare " + missing.join(", ") + " on " + toolKey : null
  };
}

/**
 * A progress summary for the dashboard: counts only, no node content, so it can
 * be rendered without re-checking what any node's output holds.
 */
export function summarizeGraph(nodes) {
  const counts = {};
  for (const status of Object.values(NODE_STATUS)) counts[status] = 0;
  for (const node of nodes) counts[node.status] = (counts[node.status] || 0) + 1;
  return {
    status: deriveGraphStatus(nodes),
    total: nodes.length,
    counts,
    complete: nodes.filter(isTerminal).length
  };
}
