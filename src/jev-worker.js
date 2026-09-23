import { randomUUID } from "node:crypto";
import { loadDb } from "./store.js";
import { claimableGraphWork, renewNodeLease, sweepStalledNodes } from "./jev.js";
import { executeNextNode } from "./jev-executor.js";

// The process that actually runs graph nodes.
//
// Until now every node ran inline: the API process called drainGraph, and the
// durability the graph provides was real but untested against the thing it is
// for. A lease exists so that a worker DYING is survivable, and nothing died
// separately from the API — so a crash took the control plane with it and the
// recovery path was exercised only by tests that simulated one.
//
// This is a separate process. It shares nothing with the API except the
// database, which is the only thing the claim was ever atomic through:
//
//   claim (advisory-locked, one winner)
//     -> lease (held open while the work runs)
//       -> execute
//         -> settle (capture, release, complete or fail)
//
// It adds no scheduler. Which node is next is entirely claimNextNode's answer,
// which is the same answer the inline path gets, from the same transaction.
//
// Run it with:
//
//   node src/jev-worker.js
//
// Several at once is the point. Two workers claiming simultaneously is already
// proven against Neon to produce one winner and one "nothing to do".

const DEFAULT_POLL_MS = 1000;
const DEFAULT_LEASE_MS = 120_000;
// Renew at a third of the lease: two renewals may be missed — a slow query, a
// paused process — before anything concludes this worker is gone.
const RENEW_DIVISOR = 3;

function readNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Keep a claimed node's lease alive while it runs.
 *
 * Returns the function that stops it, which the executor calls however the node
 * settles. A timer left running would keep a dead worker's lease alive and stop
 * the sweeper recovering the node — the exact failure the lease exists to
 * prevent, reintroduced by the thing meant to hold it.
 */
function holdLease(node, { leaseMs, onLost = null }) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const result = await renewNodeLease({ nodeId: node.id, leaseId: node.leaseId, leaseMs });
      if (!result.renewed && onLost) onLost(node);
    } catch {
      // A renewal that fails is not worth failing the work over: the lease will
      // expire and the node will be recovered, which is the designed outcome.
    }
    // The floor is low enough that a short lease is still renewed rather than
    // silently never renewed — a guard that outlasts the lease it protects is
    // worse than no guard, because it looks like one.
  }, Math.max(250, Math.floor(leaseMs / RENEW_DIVISOR)));

  // Node keeps the process alive for pending timers; a worker should be able to
  // exit while one is outstanding.
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Claim and run at most one node, from any graph this worker is eligible for.
 *
 * Returns `null` when there is nothing to do, which is an ordinary and frequent
 * answer rather than an error: most polls find an empty queue.
 */
export async function runWorkerOnce({
  workerId,
  workspaceRootFor = null,
  runtime = null,
  adapters = {},
  modelRegistry = null,
  resourceClass = null,
  leaseMs = DEFAULT_LEASE_MS,
  now = () => new Date()
} = {}) {
  const work = await claimableGraphWork({ resourceClass });
  if (work.length === 0) return null;

  // Try each candidate: another worker may take the first between this read and
  // the claim, and that is expected rather than exceptional.
  for (const candidate of work) {
    const db = await loadDb();
    const agent = db.agentInstances.find(item => item.id === candidate.agentInstanceId);
    if (!agent) continue;

    const workspace = db.workspaces.find(item => item.id === agent.workspaceId);
    const workspaceRoot = workspaceRootFor
      ? await workspaceRootFor(agent, workspace)
      : workspace?.path;
    if (!workspaceRoot) continue;

    let lost = false;
    const result = await executeNextNode({
      agentInstanceId: agent.id,
      taskId: candidate.taskId,
      tenantId: candidate.tenantId,
      workspaceRoot,
      runtime,
      adapters,
      modelRegistry,
      workerId,
      leaseMs,
      onClaim: node => holdLease(node, { leaseMs, onLost: () => { lost = true; } }),
      now: now()
    });

    if (!result) continue;
    return { ...result, agentInstanceId: agent.id, taskId: candidate.taskId, leaseLost: lost };
  }

  return null;
}

/**
 * Run until told to stop.
 *
 * `signal` is how it is told. Stopping means stopping CLAIMING — a node already
 * running finishes and settles, because abandoning it would leave work that has
 * been paid for waiting on a lease to expire.
 */
export async function runWorker({
  workerId = process.env.RAZEKIT_JEV_WORKER_ID || "jev-worker-" + randomUUID().slice(0, 8),
  pollMs = readNumber("RAZEKIT_JEV_WORKER_POLL_MS", DEFAULT_POLL_MS),
  leaseMs = readNumber("RAZEKIT_JEV_WORKER_LEASE_MS", DEFAULT_LEASE_MS),
  resourceClass = process.env.RAZEKIT_JEV_WORKER_RESOURCE_CLASS || null,
  adapters = {},
  runtime = null,
  modelRegistry = null,
  sweep = true,
  signal = null,
  maxIterations = Infinity,
  onResult = null
} = {}) {
  const stats = { claimed: 0, succeeded: 0, failed: 0, idle: 0, swept: 0, iterations: 0 };

  while (stats.iterations < maxIterations && !signal?.aborted) {
    stats.iterations += 1;

    if (sweep) {
      // Any worker may recover any node. There is no sweeper process to lose,
      // and a stalled node left behind by a worker that died is not the dead
      // worker's problem to solve.
      try {
        const swept = await sweepStalledNodes({ now: new Date() });
        stats.swept += (swept.recovered?.length ?? 0) + (swept.timedOut?.length ?? 0);
      } catch {
        // A failed sweep is not a reason to stop taking work.
      }
    }

    let result = null;
    try {
      result = await runWorkerOnce({ workerId, adapters, runtime, modelRegistry, resourceClass, leaseMs });
    } catch (error) {
      // A node that threw past its own settlement is a bug, not a reason for
      // the worker to exit: exiting would take every other task with it.
      stats.failed += 1;
      if (onResult) await onResult({ error: error.message || "worker iteration failed" });
    }

    if (result) {
      stats.claimed += 1;
      if (result.status === "succeeded") stats.succeeded += 1;
      else if (["failed", "budget_refused", "outcome_unknown"].includes(result.status)) stats.failed += 1;
      if (onResult) await onResult(result);
      // Straight back round: a busy queue should not be polled at idle speed.
      continue;
    }

    stats.idle += 1;
    if (stats.iterations >= maxIterations || signal?.aborted) break;
    await sleep(pollMs, signal);
  }

  return stats;
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    // Deliberately NOT unref'd: a worker whose only pending work is its own
    // poll timer must stay alive, not exit because the queue went quiet.
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

/** Entry point when this file is run directly. */
async function main() {
  const controller = new AbortController();
  let stopping = false;

  for (const name of ["SIGINT", "SIGTERM"]) {
    process.on(name, () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log("\nStopping after the current node finishes. Interrupt again to exit now.");
      controller.abort();
    });
  }

  const workerId = process.env.RAZEKIT_JEV_WORKER_ID || "jev-worker-" + randomUUID().slice(0, 8);
  console.log(
    "RazeKit DEV graph worker\n" +
    "  worker         " + workerId + "\n" +
    "  resource class " + (process.env.RAZEKIT_JEV_WORKER_RESOURCE_CLASS || "any") + "\n" +
    "  store          " + (process.env.RAZEKIT_STORE || "json")
  );
  // No model registry is configured here on purpose. A worker that reached a
  // model node without one fails it closed rather than calling a provider this
  // process was never given credentials for.
  const stats = await runWorker({ workerId, signal: controller.signal });
  console.log("Stopped. " + JSON.stringify(stats));
}

if (import.meta.url === "file://" + process.argv[1] || process.argv[1]?.endsWith("jev-worker.js")) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
