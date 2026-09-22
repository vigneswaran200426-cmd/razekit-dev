import { id, transact } from "./store.js";
import { redactAuditValue, DEFAULT_TENANT_ID, DEFAULT_USER_ID } from "./tenant-security.js";
import {
  NODE_STATUS,
  GRAPH_STATUS,
  applyReadiness,
  assertGraphShape,
  claimableNodes,
  deriveGraphStatus,
  isTerminal,
  summarizeGraph,
  topologicalOrder
} from "./jev-domain.js";

// JEV — durable execution of a task's dependency graph.
//
// This is the persistence and leasing half; the rules live in jev-domain.js.
//
// Every operation here runs inside a single transact(). On Postgres that takes
// the engine's advisory lock for the length of the transaction, so a claim is
// atomic across processes without this file writing any SQL of its own — the
// same primitive the job queue already relies on. On the JSON store it is the
// in-process promise chain, which is atomic in the only process that exists.
//
// Two rules this file will not bend:
//
//   1. Audit rows are written INSIDE the mutator, never by calling writeAudit()
//      from within one. writeAudit opens its own transact, and on Postgres a
//      nested transact waits for an advisory lock the outer transaction is
//      still holding — a deadlock, not a slow path. Appending to db.auditLogs
//      directly is also the stronger guarantee: the audit row and the state
//      change it describes commit together or not at all.
//
//   2. Time comes from the caller, never from the database. The engine host and
//      Neon were measured 154 seconds apart; a deadline written by the app and
//      compared against the database's now() expires work that is still running.

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function iso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Append an audit row in the caller's transaction. Same shape and the same
 * redaction as tenant-security's writeAudit, so one reader can read both.
 */
function auditInTransaction(db, { tenantId, userId, action, resourceId, outcome = "success", metadata = {}, now }) {
  const entry = {
    id: id("audit"),
    tenantId,
    userId,
    requestId: null,
    action,
    resourceType: "graph_node",
    resourceId,
    outcome,
    metadata: redactAuditValue(metadata),
    createdAt: iso(now)
  };
  db.auditLogs.push(entry);
  return entry;
}

function nodesOfGraph(db, graphId) {
  return db.graphNodes
    .filter(node => node.graphId === graphId)
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
}

function graphIsActive(graph) {
  return graph.status === GRAPH_STATUS.PENDING || graph.status === GRAPH_STATUS.RUNNING;
}

/** Re-derive and store the graph's status after its nodes moved. */
function refreshGraph(db, graph, now) {
  const nodes = nodesOfGraph(db, graph.id);
  graph.status = deriveGraphStatus(nodes);
  graph.updatedAt = iso(now);
  if (graph.status !== GRAPH_STATUS.PENDING && graph.status !== GRAPH_STATUS.RUNNING && !graph.finishedAt) {
    graph.finishedAt = iso(now);
  }
  return graph;
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Store a validated graph for a task.
 *
 * The shape is checked before anything is written, so an unexecutable plan — a
 * cycle, a dangling dependency, a duplicate key — is rejected at the boundary
 * rather than becoming a task that never finishes and never errors.
 *
 * A task may hold only one active graph at a time. Re-planning must cancel the
 * previous graph first; two live graphs would both schedule nodes against the
 * same workspace.
 */
export async function createTaskGraph({
  tenantId = DEFAULT_TENANT_ID,
  userId = DEFAULT_USER_ID,
  taskId,
  agentInstanceId = null,
  planId = null,
  nodes,
  now = new Date()
}) {
  if (!taskId) throw new Error("A graph requires a taskId");

  const prepared = (nodes ?? []).map((node, index) => ({
    key: String(node?.key ?? "").trim(),
    kind: node?.kind ?? "implementation",
    description: node?.description ?? "",
    dependsOn: [...(node?.dependsOn ?? [])],
    order: index,
    // A node's payload is whatever the executor for its kind needs. JEV does
    // not interpret it; scheduling must not depend on what the work is.
    payload: node?.payload ?? null,
    resourceClass: node?.resourceClass ?? "cpu",
    maxAttempts: Math.max(1, Number(node?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
    timeoutMs: Math.max(0, Number(node?.timeoutMs ?? 0)),
    budgetMinor: Math.max(0, Number(node?.budgetMinor ?? 0)),
    toolScopes: [...(node?.toolScopes ?? [])],
    status: NODE_STATUS.PENDING
  }));

  assertGraphShape(prepared);

  return transact(db => {
    const existing = db.taskGraphs.find(graph => graph.taskId === taskId && graphIsActive(graph));
    if (existing) {
      throw new Error("Task already has an active execution graph: " + existing.id);
    }

    const graph = {
      id: id("graph"),
      tenantId,
      userId,
      taskId,
      agentInstanceId,
      planId,
      status: GRAPH_STATUS.PENDING,
      createdAt: iso(now),
      updatedAt: iso(now),
      finishedAt: null
    };
    db.taskGraphs.push(graph);

    for (const node of prepared) {
      db.graphNodes.push({
        id: id("node"),
        graphId: graph.id,
        tenantId,
        userId,
        taskId,
        ...node,
        attempt: 0,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt: null,
        startedAt: null,
        finishedAt: null,
        output: null,
        error: null,
        skippedBecause: null,
        createdAt: iso(now),
        updatedAt: iso(now)
      });
    }

    // Sources have no dependencies, so this is what turns them READY.
    const stored = nodesOfGraph(db, graph.id);
    applyReadiness(stored);
    refreshGraph(db, graph, now);

    auditInTransaction(db, {
      tenantId, userId, action: "graph.created", resourceId: graph.id, now,
      metadata: { taskId, nodeCount: stored.length, order: topologicalOrder(stored) }
    });

    return { graph, nodes: stored.map(node => ({ ...node })) };
  });
}

// ── Claiming ─────────────────────────────────────────────────────────────────

/**
 * Hand exactly one claimable node to one worker.
 *
 * Whether two workers can take the same node is decided entirely by transact()'s
 * atomicity, which the Postgres store already proves under concurrency. This
 * function's own job is narrower: never offer a node whose dependencies have not
 * actually succeeded, and stamp a lease the completer must present back.
 */
export async function claimNextNode({
  taskId = null,
  tenantId = null,
  workerId,
  resourceClass = null,
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date()
}) {
  if (!String(workerId || "").trim()) throw new Error("A node claim requires a workerId");

  return transact(db => {
    const graphs = db.taskGraphs
      .filter(graphIsActive)
      .filter(graph => (taskId ? graph.taskId === taskId : true))
      .filter(graph => (tenantId ? graph.tenantId === tenantId : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    for (const graph of graphs) {
      const nodes = nodesOfGraph(db, graph.id);
      const [node] = claimableNodes(nodes, { resourceClass });
      if (!node) continue;

      const claimedAt = new Date(iso(now)).getTime();
      node.status = NODE_STATUS.RUNNING;
      node.attempt = Number(node.attempt || 0) + 1;
      node.leaseId = id("lease");
      node.leaseOwner = workerId;
      node.leaseExpiresAt = new Date(claimedAt + Math.max(1000, leaseMs)).toISOString();
      // The deadline is the node's own budget of wall-clock time and is set once,
      // on the first attempt, so a node cannot buy itself more time by failing.
      node.deadlineAt = node.timeoutMs > 0
        ? (node.deadlineAt ?? new Date(claimedAt + node.timeoutMs).toISOString())
        : null;
      node.startedAt = node.startedAt ?? iso(now);
      node.updatedAt = iso(now);

      refreshGraph(db, graph, now);
      auditInTransaction(db, {
        tenantId: graph.tenantId, userId: graph.userId, action: "graph.node.claimed",
        resourceId: node.id, now,
        metadata: { graphId: graph.id, key: node.key, workerId, attempt: node.attempt }
      });

      return { graph: { ...graph }, node: { ...node } };
    }

    return null;
  });
}

/**
 * Extend a lease on work that is still running.
 *
 * Without this, a node that legitimately takes longer than one lease is
 * reclaimed and executed a second time. The fence is the lease id: a worker that
 * already lost the node cannot talk its way back into ownership.
 */
export async function renewNodeLease({ nodeId, leaseId, leaseMs = DEFAULT_LEASE_MS, now = new Date() }) {
  return transact(db => {
    const node = db.graphNodes.find(item => item.id === nodeId);
    if (!node) throw new Error("Unknown graph node: " + nodeId);
    if (node.status !== NODE_STATUS.RUNNING || node.leaseId !== leaseId) {
      return { renewed: false, node: { ...node } };
    }
    node.leaseExpiresAt = new Date(new Date(iso(now)).getTime() + Math.max(1000, leaseMs)).toISOString();
    node.updatedAt = iso(now);
    return { renewed: true, node: { ...node } };
  });
}

// ── Completion ───────────────────────────────────────────────────────────────

/**
 * Mark a node succeeded and release whatever it unblocks.
 *
 * Fenced on the lease. A worker that was declared dead, had its node reassigned,
 * and then woke up to report success must not be able to overwrite the outcome
 * of the worker that actually did the work. It is told `accepted: false` rather
 * than being failed, because from its own point of view nothing went wrong.
 *
 * Idempotent on retry: presenting the same lease for a node this same lease
 * already completed returns the stored result instead of re-running readiness.
 */
export async function completeNode({ nodeId, leaseId, output = null, now = new Date() }) {
  return transact(db => {
    const node = db.graphNodes.find(item => item.id === nodeId);
    if (!node) throw new Error("Unknown graph node: " + nodeId);

    if (node.status === NODE_STATUS.SUCCEEDED && node.leaseId === leaseId) {
      return { accepted: true, repeated: true, node: { ...node }, unblocked: [] };
    }
    if (node.status !== NODE_STATUS.RUNNING || node.leaseId !== leaseId) {
      return { accepted: false, reason: "lease-not-current", node: { ...node }, unblocked: [] };
    }

    const graph = db.taskGraphs.find(item => item.id === node.graphId);
    node.status = NODE_STATUS.SUCCEEDED;
    node.output = output;
    node.error = null;
    node.finishedAt = iso(now);
    node.updatedAt = iso(now);
    node.leaseExpiresAt = null;

    const nodes = nodesOfGraph(db, node.graphId);
    const changed = applyReadiness(nodes);
    for (const item of nodes) if (changed.some(c => c.key === item.key)) item.updatedAt = iso(now);
    refreshGraph(db, graph, now);

    auditInTransaction(db, {
      tenantId: node.tenantId, userId: node.userId, action: "graph.node.succeeded",
      resourceId: node.id, now,
      metadata: { graphId: node.graphId, key: node.key, attempt: node.attempt, unblocked: changed }
    });

    return { accepted: true, repeated: false, node: { ...node }, unblocked: changed, graph: { ...graph } };
  });
}

/**
 * Record a failed attempt.
 *
 * Retryable and attempts remaining -> back to READY, and any worker may pick it
 * up; the previous lease is void, so the failing worker holds no claim on the
 * retry. Otherwise the node is terminal and everything downstream of it becomes
 * SKIPPED in the same transaction — a dependent left PENDING behind a dead
 * dependency is a task that hangs without ever reporting an error.
 *
 * `retryable` is the caller's classification and is not inferred here. Guessing
 * from an error message is how budget exhaustion became an infinite retry loop.
 */
export async function failNode({ nodeId, leaseId, error, retryable = false, now = new Date() }) {
  return transact(db => {
    const node = db.graphNodes.find(item => item.id === nodeId);
    if (!node) throw new Error("Unknown graph node: " + nodeId);
    if (node.status !== NODE_STATUS.RUNNING || node.leaseId !== leaseId) {
      return { accepted: false, reason: "lease-not-current", node: { ...node } };
    }

    const graph = db.taskGraphs.find(item => item.id === node.graphId);
    const message = typeof error === "string" ? error : (error?.message ?? "unknown failure");
    const attemptsLeft = Number(node.attempt || 0) < Number(node.maxAttempts || DEFAULT_MAX_ATTEMPTS);
    const willRetry = retryable && attemptsLeft;

    node.error = { message, retryable, attempt: node.attempt, at: iso(now) };
    node.leaseId = null;
    node.leaseOwner = null;
    node.leaseExpiresAt = null;
    node.status = willRetry ? NODE_STATUS.READY : NODE_STATUS.FAILED;
    if (!willRetry) node.finishedAt = iso(now);
    node.updatedAt = iso(now);

    const nodes = nodesOfGraph(db, node.graphId);
    const skipped = willRetry ? [] : applyReadiness(nodes);
    for (const item of nodes) if (skipped.some(c => c.key === item.key)) item.updatedAt = iso(now);
    refreshGraph(db, graph, now);

    auditInTransaction(db, {
      tenantId: node.tenantId, userId: node.userId,
      action: willRetry ? "graph.node.retry_scheduled" : "graph.node.failed",
      resourceId: node.id, outcome: willRetry ? "success" : "failure", now,
      metadata: { graphId: node.graphId, key: node.key, attempt: node.attempt, message, retryable, skipped }
    });

    return { accepted: true, willRetry, node: { ...node }, skipped, graph: { ...graph } };
  });
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Reclaim work whose worker stopped reporting, and time out work that has run
 * past its own deadline.
 *
 * These are two different failures and are not collapsed:
 *
 *   lease expired    the WORKER is gone. The node may be perfectly fine, so it
 *                    goes back to READY if it has attempts left. This is what
 *                    makes a killed container recoverable rather than fatal.
 *
 *   deadline passed  the NODE is too slow. Retrying buys nothing — it would just
 *                    be too slow again — so it is terminal immediately.
 */
export async function sweepStalledNodes({ now = new Date(), tenantId = null } = {}) {
  return transact(db => {
    const at = new Date(iso(now)).getTime();
    const recovered = [];
    const timedOut = [];
    const touchedGraphs = new Set();

    const running = db.graphNodes.filter(node =>
      node.status === NODE_STATUS.RUNNING && (tenantId ? node.tenantId === tenantId : true)
    );

    for (const node of running) {
      const pastDeadline = node.deadlineAt && Date.parse(node.deadlineAt) <= at;
      const lostWorker = node.leaseExpiresAt && Date.parse(node.leaseExpiresAt) <= at;
      if (!pastDeadline && !lostWorker) continue;

      node.leaseId = null;
      node.leaseOwner = null;
      node.leaseExpiresAt = null;
      node.updatedAt = iso(now);
      touchedGraphs.add(node.graphId);

      if (pastDeadline) {
        node.status = NODE_STATUS.TIMED_OUT;
        node.finishedAt = iso(now);
        node.error = { message: "Node exceeded its deadline", retryable: false, attempt: node.attempt, at: iso(now) };
        timedOut.push({ id: node.id, key: node.key, graphId: node.graphId });
        auditInTransaction(db, {
          tenantId: node.tenantId, userId: node.userId, action: "graph.node.timed_out",
          resourceId: node.id, outcome: "failure", now,
          metadata: { graphId: node.graphId, key: node.key, attempt: node.attempt }
        });
        continue;
      }

      if (Number(node.attempt || 0) < Number(node.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
        node.status = NODE_STATUS.READY;
        recovered.push({ id: node.id, key: node.key, graphId: node.graphId });
        auditInTransaction(db, {
          tenantId: node.tenantId, userId: node.userId, action: "graph.node.lease_recovered",
          resourceId: node.id, now,
          metadata: { graphId: node.graphId, key: node.key, attempt: node.attempt }
        });
      } else {
        node.status = NODE_STATUS.FAILED;
        node.finishedAt = iso(now);
        node.error = { message: "Worker lease expired with no attempts remaining", retryable: false, attempt: node.attempt, at: iso(now) };
        auditInTransaction(db, {
          tenantId: node.tenantId, userId: node.userId, action: "graph.node.failed",
          resourceId: node.id, outcome: "failure", now,
          metadata: { graphId: node.graphId, key: node.key, reason: "lease-exhausted" }
        });
      }
    }

    const skipped = [];
    for (const graphId of touchedGraphs) {
      const nodes = nodesOfGraph(db, graphId);
      skipped.push(...applyReadiness(nodes));
      const graph = db.taskGraphs.find(item => item.id === graphId);
      if (graph) refreshGraph(db, graph, now);
    }

    return { recovered, timedOut, skipped };
  });
}

/**
 * Stop a graph. Every node that has not settled becomes CANCELLED, including
 * nodes a worker currently holds — their leases are void, so when that worker
 * reports back it is told the lease is not current and its result is discarded
 * rather than resurrecting a cancelled graph.
 */
export async function cancelGraph({ graphId, reason = "cancelled by operator", now = new Date() }) {
  return transact(db => {
    const graph = db.taskGraphs.find(item => item.id === graphId);
    if (!graph) throw new Error("Unknown execution graph: " + graphId);

    const nodes = nodesOfGraph(db, graphId);
    const cancelled = [];
    for (const node of nodes) {
      if (isTerminal(node)) continue;
      node.status = NODE_STATUS.CANCELLED;
      node.leaseId = null;
      node.leaseOwner = null;
      node.leaseExpiresAt = null;
      node.finishedAt = iso(now);
      node.updatedAt = iso(now);
      node.error = { message: reason, retryable: false, attempt: node.attempt, at: iso(now) };
      cancelled.push(node.key);
    }

    refreshGraph(db, graph, now);
    auditInTransaction(db, {
      tenantId: graph.tenantId, userId: graph.userId, action: "graph.cancelled",
      resourceId: graph.id, now, metadata: { reason, cancelled }
    });

    return { graph: { ...graph }, cancelled };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * A graph and its nodes, scoped to a tenant.
 *
 * `tenantId` is required and applied here rather than by the caller: a read
 * helper that returns another tenant's graph when someone forgets to filter is
 * a cross-tenant leak waiting for one careless call site.
 */
export async function graphForTask({ taskId, tenantId, includeFinished = false }) {
  if (!tenantId) throw new Error("A graph read requires a tenantId");
  return transact(db => {
    const graphs = db.taskGraphs
      .filter(graph => graph.taskId === taskId && graph.tenantId === tenantId)
      .filter(graph => (includeFinished ? true : graphIsActive(graph)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const graph = graphs[0];
    if (!graph) return null;
    const nodes = nodesOfGraph(db, graph.id).map(node => ({ ...node }));
    return { graph: { ...graph }, nodes, summary: summarizeGraph(nodes) };
  });
}
