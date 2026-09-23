import { id, loadDb, transact } from "./store.js";
import { NODE_STATUS, GRAPH_STATUS } from "./jev-domain.js";
import { claimNextNode, completeNode, failNode, graphForTask, createTaskGraph } from "./jev.js";
import { graphFromExecutionPlan, distributeBudgetMinor } from "./jev-planner.js";
import { reserveNodeBudget, captureNodeBudget, releaseNodeBudget, majorToMinor } from "./jev-budget.js";
import { getAgent } from "./agent-manager.js";
import { writeBlackboard } from "./blackboard.js";
import { writeCheckpoint } from "./reliability.js";
import { tenantForTask } from "./tenant-security.js";
import { profileForAgent } from "./jev-profiles.js";
import { isModelNodeKind } from "./jev-model-domain.js";
import { executeModelNode, compileModelContext, recordModelPhaseEvent } from "./jev-model-executor.js";
import { readNumberEnv } from "./adapters/model-json.js";

// Draining a task's graph.
//
// This replaces the flat loop in ExecutionEngine for graph-backed execution. It
// does NOT replace the runtimes: a node's work is still handed to the same
// AppWebRuntime that the flat path used, with the same workspace confinement
// and the same step semantics. What changes is only which step runs next, and
// what has to be true before it does.
//
// Per node, in this order and for a reason:
//
//   1. claim        atomic; the lease is the only thing that grants ownership
//   2. reserve      budget is held BEFORE the work, so a node that cannot be
//                   afforded never starts. Reserving afterwards would be
//                   accounting, not enforcement.
//   3. execute      through the existing runtime
//   4. settle       capture what was actually spent, release the rest
//   5. complete     fenced on the lease from step 1
//
// If step 3 throws, step 4 still runs. A reservation left behind by a crashed
// node is budget nobody can spend and nobody can get back.

const DEFAULT_LEASE_MS = 120_000;

// What one executing node is expected to cost, in whole currency units.
//
// This is the SAME knob the flat executor used for a whole run, and it still
// defaults to zero, so execution is free by default and the budget is enforced
// by being *checked* rather than by being consumed. Reading it per call rather
// than once at import keeps it configurable in tests.
function executionCostPerNode() {
  return readNumberEnv("RAZEKIT_EXECUTION_RUN_COST", 0);
}

/**
 * Build a graph for whatever the planner produced and store it.
 *
 * A node's `budgetMinor` is a CEILING on what that node may spend, derived from
 * the configured per-node execution cost — not a share of the task's money.
 *
 * The difference matters. Handing each node a slice of the whole remaining
 * budget would mean the first build consumed the entire task budget even when
 * execution costs nothing, and the second build could never run. The budget is
 * there to stop runaway spend, not to be spent.
 *
 * `totalBudgetMinor` overrides this for a caller that genuinely knows the total
 * it wants distributed — a model phase with a real token cost, for instance.
 * Either way the sum is capped at what the agent actually has left, so a graph
 * can never reserve money already used.
 */
export async function createGraphForAgent(agentInstanceId, {
  plan = null,
  totalBudgetMinor = null,
  now = new Date()
} = {}) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");

  const db = await loadDb();
  const task = db.tasks.find(item => item.id === agent.taskId);
  if (!task) throw new Error("Task not found");

  const profile = profileForAgent(agent);
  const taskType = profile.taskType;

  // A caller-supplied plan is normalised through the profile's own validator,
  // so a game plan is checked against the game contract rather than the
  // App/Web one. An unusable plan is rejected here, before a graph exists.
  const executionPlan = plan
    ? (profile.normalizePlan(plan) ?? (() => { throw new Error("Execution plan is not valid for " + taskType); })())
    : await profile.buildPlan(agentInstanceId);

  const nodes = graphFromExecutionPlan(executionPlan, { taskType });

  const remainingMinor = majorToMinor(Math.max(
    0,
    Number(agent.budgetLimit || 0) - Number(agent.budgetUsed || 0)
  ));

  if (totalBudgetMinor !== null) {
    distributeBudgetMinor(nodes, Math.min(Number(totalBudgetMinor), remainingMinor), { taskType });
  } else {
    // Per-node ceiling from the configured cost. At the default of zero this
    // leaves every node at zero, no reservation is taken, and execution behaves
    // exactly as it did on the flat path.
    const perNodeMinor = majorToMinor(executionCostPerNode());
    if (perNodeMinor > 0) {
      let allocated = 0;
      for (const node of nodes) {
        if (node.budgetMinor > 0) continue; // a plan may price a step itself
        const grant = Math.min(perNodeMinor, Math.max(0, remainingMinor - allocated));
        node.budgetMinor = grant;
        allocated += grant;
      }
    }
  }

  const tenantId = await tenantForTask(agent.taskId);

  return createTaskGraph({
    tenantId,
    userId: task.userId || "local-user",
    taskId: agent.taskId,
    agentInstanceId,
    planId: executionPlan.id,
    nodes,
    now
  });
}

/**
 * Run one node: claim, reserve, execute, settle, record.
 *
 * Returns null when there is nothing claimable, so a caller can use that as the
 * drain's stopping condition without a second query.
 */
export async function executeNextNode({
  agentInstanceId,
  workspaceRoot,
  runtime = null,
  adapters = {},
  modelRegistry = null,
  taskId = null,
  tenantId = null,
  workerId = "inline-worker",
  leaseMs = DEFAULT_LEASE_MS,
  // Called with the claimed node before any work starts, and given a chance to
  // clean up afterwards. A worker whose node outlives its lease is swept and
  // its work is run twice, so a long-running node needs something holding the
  // lease open while it runs — and only the caller knows how long that is.
  onClaim = null,
  now = new Date()
}) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  const profile = profileForAgent(agent);

  const claim = await claimNextNode({
    taskId: taskId || agent.taskId,
    tenantId: tenantId || await tenantForTask(agent.taskId),
    workerId,
    leaseMs,
    now
  });
  if (!claim) return null;

  const { node } = claim;

  // Whatever the caller returns here is released once the node settles, however
  // it settles — a renewal timer left running would keep a dead node's lease
  // alive and stop the sweeper recovering it.
  const release = onClaim ? await onClaim(node) : null;
  const finish = async result => {
    if (typeof release === "function") await release();
    return result;
  };

  // ── A model node settles its own budget ───────────────────────────────────
  //
  // Reserve-before-call has to happen around the provider request itself, not
  // around this whole function, so the model executor owns that window. It
  // returns through the same success/failure path as everything else, which is
  // why there is still exactly one settlement per node.
  if (isModelNodeKind(node.kind)) {
    return finish(await executeModelNodeThroughGraph({
      node, agent, profile, modelRegistry, now, agentInstanceId
    }));
  }

  // ── Budget, before any work ───────────────────────────────────────────────
  const hold = await reserveNodeBudget({ node, agentInstanceId });
  if (!hold.reserved) {
    // Not retryable: this came from our own limit, not from a provider. Marking
    // it retryable would spin the node against a ceiling that exists to stop it.
    const result = await failNode({
      nodeId: node.id,
      leaseId: node.leaseId,
      error: "Budget refused: " + hold.reason,
      retryable: false,
      now
    });
    await writeBlackboard(
      agentInstanceId,
      profile.keys.lastResult + ".budgetRefusal",
      { nodeKey: node.key, limit: hold.limit, reason: hold.reason },
      "jev-executor"
    );
    return finish({
      node: result.node,
      status: "budget_refused",
      limit: hold.limit,
      reason: hold.reason,
      skipped: result.skipped
    });
  }

  // ── Work ──────────────────────────────────────────────────────────────────
  const activeRuntime = runtime || profile.createRuntime({ workspaceRoot, adapters });
  let output = null;
  let failure = null;

  try {
    output = await runWithTimeout(
      () => activeRuntime.execute(node.payload, {
        agentInstanceId,
        taskId: agent.taskId,
        nodeId: node.id,
        graphId: node.graphId,
        attempt: node.attempt,
        // A game step reads `step.engine || context.engine`. The planner stamps
        // the engine onto the payload, and this is the second half of that
        // contract for any step that was written without one.
        ...(node.payload?.engine ? { engine: node.payload.engine } : {})
      }),
      node.timeoutMs
    );
  } catch (error) {
    failure = error;
  }

  // ── Settle, whichever way it went ─────────────────────────────────────────
  //
  // The hold never survives this function, but success and failure settle
  // differently and the asymmetry is deliberate.
  //
  //   succeeded   captures the reservation unless the runtime measured less.
  //               The reservation is the estimate, and a node that did the work
  //               it reserved for should be charged for it — assuming zero for
  //               every unmeasured node would make the budget stop binding.
  //
  //   failed      captures only what was actually measured, and releases the
  //               whole hold when nothing was. There is no evidence of cost, and
  //               charging the estimate for a failure is not just harsh: a node
  //               may hold a large share of the remaining budget, so capturing
  //               it in full would leave nothing for the retry and make
  //               maxAttempts unreachable by construction.
  //
  // Repeated failure is bounded by maxAttempts and by the tenant command-rate
  // limits, not by charging for work that produced nothing.
  try {
    const measured = measuredSpendMinor(output);
    if (failure) {
      if (measured === null) {
        await releaseNodeBudget({ reservation: hold.reservation });
      } else {
        await captureNodeBudget({ reservation: hold.reservation, actualMinor: measured });
      }
    } else {
      await captureNodeBudget({
        reservation: hold.reservation,
        actualMinor: measured === null ? hold.amountMinor : Math.min(measured, hold.amountMinor)
      });
    }
  } catch (settlementError) {
    // Settlement must never mask the real outcome of the work. It is recorded
    // and execution continues; the reservation is visible in the ledger either
    // way and a stuck one is an operator problem, not a reason to lose the run.
    await writeBlackboard(
      agentInstanceId,
      "execution.lastSettlementError",
      { nodeKey: node.key, error: settlementError.message },
      "jev-executor"
    );
  }

  if (failure) {
    const retryable = isRetryable(failure);
    const result = await failNode({
      nodeId: node.id,
      leaseId: node.leaseId,
      error: failure.message || "Node execution failed",
      retryable,
      now
    });
    await writeBlackboard(
      agentInstanceId,
      profile.keys.lastEvent,
      { type: "node_failed", nodeKey: node.key, attempt: node.attempt, error: failure.message },
      "jev-executor"
    );
    await recordCycleForNode({ agentInstanceId, node, tenantId, taskId });
    return finish({
      node: result.node,
      status: result.willRetry ? "retry_scheduled" : "failed",
      error: failure.message,
      skipped: result.skipped
    });
  }

  const done = await completeNode({ nodeId: node.id, leaseId: node.leaseId, output, now });
  await writeBlackboard(
    agentInstanceId,
    profile.keys.lastEvent,
    { type: "node_succeeded", nodeKey: node.key, attempt: node.attempt },
    "jev-executor"
  );

  await recordCycleForNode({ agentInstanceId, node, tenantId, taskId });

  return finish({
    node: done.node,
    status: done.accepted ? "succeeded" : "lease_lost",
    unblocked: done.unblocked,
    output
  });
}

/**
 * Run nodes until the graph settles or the step ceiling is reached.
 *
 * `maxSteps` is a guard, not a policy: without it a graph whose nodes keep
 * failing retryably would spin here instead of returning to the loop that can
 * decide to stop. Reaching it is reported, never silently treated as success.
 */
export async function drainGraph({
  agentInstanceId,
  workspaceRoot,
  runtime = null,
  adapters = {},
  modelRegistry = null,
  workerId = "inline-worker",
  maxSteps = 200,
  now = () => new Date()
}) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  const profile = profileForAgent(agent);
  const tenantId = await tenantForTask(agent.taskId);

  const runId = id("jevrun");
  await transact(db => {
    db.executionRuns.push({
      id: runId,
      taskId: agent.taskId,
      agentInstanceId,
      kind: profile.runKind,
      planId: null,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null
    });
  });

  const executed = [];
  let steps = 0;
  let exhausted = false;

  while (steps < maxSteps) {
    steps += 1;
    const result = await executeNextNode({
      agentInstanceId,
      workspaceRoot,
      runtime,
      adapters,
      modelRegistry,
      tenantId,
      workerId,
      now: now()
    });
    if (!result) break;
    executed.push({ key: result.node.key, status: result.status });

    // Checkpoint after every node, so a worker that dies mid-drain leaves a
    // record of exactly how far it got rather than an empty run row.
    await writeCheckpoint(
      { agentInstanceId, taskId: agent.taskId, kind: profile.runKind, scopeId: runId },
      { executed, steps },
      { runId }
    );

    if (steps === maxSteps) exhausted = true;
  }

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  const graphStatus = view?.graph?.status ?? GRAPH_STATUS.PENDING;

  const status =
    graphStatus === GRAPH_STATUS.SUCCEEDED ? "completed" :
    graphStatus === GRAPH_STATUS.CANCELLED ? "cancelled" :
    graphStatus === GRAPH_STATUS.FAILED ? "failed" :
    exhausted ? "step_limit_reached" : "incomplete";

  const firstFailure = view?.nodes?.find(node =>
    node.status === NODE_STATUS.FAILED || node.status === NODE_STATUS.TIMED_OUT
  );

  await transact(db => {
    const run = db.executionRuns.find(item => item.id === runId);
    if (!run) return;
    run.status = status;
    run.completedAt = new Date().toISOString();
    run.planId = view?.graph?.planId ?? null;
    run.result = {
      executed,
      steps,
      summary: view?.summary ?? null,
      // `result.plan.steps` is a CONTRACT, not an implementation detail: the
      // verifier reads it to decide whether the work is real, and the dashboard
      // reads it for deliverables. The graph is the source of truth, and this
      // projects it into the shape those readers already consume — so moving
      // execution onto JEV does not quietly blind verification.
      plan: {
        id: view?.graph?.planId ?? null,
        steps: (view?.nodes ?? []).map(nodeAsStep)
      }
    };
    run.error = firstFailure ? (firstFailure.error?.message || "Node failed: " + firstFailure.key) : null;
    // The flat executor recorded package-step results on the run, and the
    // dashboard's deliverables list reads them from there. Moving onto JEV must
    // not quietly stop producing them.
    run.artifacts = (view?.nodes ?? [])
      .filter(n => profile.packageKinds.includes(n.kind) && n.status === NODE_STATUS.SUCCEEDED && n.output)
      .map(n => n.output);
  });

  await writeBlackboard(
    agentInstanceId,
    profile.keys.lastResult,
    {
      runId,
      status,
      planId: view?.graph?.planId ?? null,
      graphId: view?.graph?.id ?? null,
      engine: view?.nodes?.find(n => n.payload?.engine)?.payload?.engine ?? null,
      artifacts: (view?.nodes ?? [])
        .filter(n => profile.packageKinds.includes(n.kind) && n.status === NODE_STATUS.SUCCEEDED && n.output)
        .map(n => n.output),
      completedAt: new Date().toISOString(),
      error: firstFailure ? (firstFailure.error?.message || "Node failed: " + firstFailure.key) : null
    },
    "jev-executor"
  );

  return { runId, status, executed, steps, summary: view?.summary ?? null, graph: view?.graph ?? null };
}

/**
 * Update the cycle run record for a node that has just settled, if it belongs
 * to a cycle.
 *
 * Called here, at the point of settlement, rather than by the loop — because
 * once workers run the nodes the loop is not there when they settle, and the
 * review and the verifier both read this record. Recording it in the caller
 * meant it was only written when the caller happened to be the executor.
 */
async function recordCycleForNode({ agentInstanceId, node, tenantId, taskId }) {
  const match = /^exec(\d+):/.exec(node.key || "");
  if (!match) return null;
  try {
    return await syncExecutionCycleRun({
      agentInstanceId, cycle: Number(match[1]), tenantId, taskId
    });
  } catch {
    // The node's own outcome is already durable; a failed projection must not
    // turn a settled node into an error.
    return null;
  }
}

/**
 * Record one execution cycle of a model graph as an execution run.
 *
 * `run.result.plan.steps` is a CONTRACT — the verifier reads it to decide
 * whether the work is real, the dashboard reads it for deliverables, and the
 * reviewer reads the blackboard summary derived from it. drainGraph has always
 * produced it; a loop that runs nodes one at a time has to produce it too, or
 * moving the model phases onto the graph would quietly blind verification.
 *
 * Scoped to ONE cycle rather than the whole graph, and that scoping is the
 * point: the review for cycle N must see whether cycle N's steps passed. The
 * graph as a whole is still RUNNING at that moment — the review node itself is
 * pending — so a whole-graph status would report "incomplete" forever and every
 * review would revise.
 */
export async function syncExecutionCycleRun({ agentInstanceId, cycle, tenantId = null, taskId = null }) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  const profile = profileForAgent(agent);
  const view = await graphForTask({
    taskId: taskId || agent.taskId,
    tenantId: tenantId || await tenantForTask(agent.taskId),
    includeFinished: true
  });
  if (!view) return null;

  const prefix = "exec" + cycle + ":";
  const nodes = view.nodes.filter(node => node.key.startsWith(prefix));
  if (nodes.length === 0) return null;

  const failed = nodes.find(node =>
    node.status === NODE_STATUS.FAILED || node.status === NODE_STATUS.TIMED_OUT
  );
  const status =
    failed ? "failed" :
    nodes.every(node => node.status === NODE_STATUS.SUCCEEDED) ? "completed" :
    nodes.some(node => node.status === NODE_STATUS.CANCELLED) ? "cancelled" :
    "incomplete";

  const runId = "jevrun_" + view.graph.id + "_c" + cycle;
  const error = failed ? (failed.error?.message || failed.lastError || "Node failed: " + failed.key) : null;
  const artifacts = nodes
    .filter(n => profile.packageKinds.includes(n.kind) && n.status === NODE_STATUS.SUCCEEDED && n.output)
    .map(n => n.output);

  await transact(db => {
    let run = db.executionRuns.find(item => item.id === runId);
    if (!run) {
      run = {
        id: runId,
        taskId: agent.taskId,
        agentInstanceId,
        kind: profile.runKind,
        planId: view.graph.planId ?? null,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        result: null,
        error: null
      };
      db.executionRuns.push(run);
    }
    run.status = status;
    run.completedAt = status === "incomplete" ? null : new Date().toISOString();
    run.planId = view.graph.planId ?? null;
    run.result = {
      cycle,
      executed: nodes.map(node => ({ key: node.key, status: node.status })),
      steps: nodes.length,
      summary: view.summary ?? null,
      plan: {
        id: view.graph.planId ?? null,
        steps: nodes.map(nodeAsStep)
      }
    };
    run.error = error;
    run.artifacts = artifacts;
  });

  await writeBlackboard(
    agentInstanceId,
    profile.keys.lastResult,
    {
      runId,
      cycle,
      status,
      planId: view.graph.planId ?? null,
      graphId: view.graph.id,
      engine: nodes.find(n => n.payload?.engine)?.payload?.engine ?? null,
      artifacts,
      completedAt: new Date().toISOString(),
      error
    },
    "jev-executor"
  );

  return { runId, status, cycle, steps: nodes.length, error };
}

/**
 * Run a claimed model node and settle it through the ordinary JEV lifecycle.
 *
 * The node is already claimed and leased by the caller. This adds nothing to
 * that lifecycle: it completes or fails the node with the same lease fence, the
 * same retry classification and the same failure propagation a file write gets.
 * What differs is only that the work is a provider call, and that the budget
 * window is opened and closed around that call by the model executor.
 */
async function executeModelNodeThroughGraph({ node, agent, profile, modelRegistry, now, agentInstanceId }) {
  if (!modelRegistry) {
    // Failing closed rather than skipping: a graph that silently dropped its
    // planning node would run an implementation against no plan at all.
    const result = await failNode({
      nodeId: node.id, leaseId: node.leaseId,
      error: "No model registry is configured for this worker",
      retryable: false, now
    });
    return { node: result.node, status: "failed", error: "No model registry is configured", skipped: result.skipped };
  }

  const db = await loadDb();
  const task = db.tasks.find(item => item.id === agent.taskId);
  const graphNodes = db.graphNodes.filter(item => item.graphId === node.graphId);
  const blackboard = db.agentBlackboards
    .filter(item => item.agentInstanceId === agent.id)
    .map(item => ({ key: item.key, value: safeParse(item.value) }));

  const context = await compileModelContext({ agent, task, node, graphNodes, blackboard });

  await recordModelPhaseEvent({
    agentInstanceId, taskId: agent.taskId, node, status: "started",
    detail: { kind: node.kind, attempt: node.attempt }
  });

  let output = null;
  let failure = null;
  try {
    output = await executeModelNode({ node, agent, registry: modelRegistry, context, profile, now });
  } catch (error) {
    failure = error;
  }

  // The model executor reports a budget refusal rather than throwing, because a
  // node that cannot be afforded is an ordinary graph outcome.
  if (output?.budgetRefused) {
    const result = await failNode({
      nodeId: node.id, leaseId: node.leaseId,
      error: "Budget refused: " + output.reason,
      retryable: false, now
    });
    await writeBlackboard(
      agentInstanceId,
      profile.keys.lastResult + ".budgetRefusal",
      { nodeKey: node.key, limit: output.limit, reason: output.reason, model: true },
      "jev-model-executor"
    );
    await recordModelPhaseEvent({
      agentInstanceId, taskId: agent.taskId, node, status: "budget_refused",
      detail: { reason: output.reason }
    });
    return {
      node: result.node, status: "budget_refused",
      limit: output.limit, reason: output.reason, skipped: result.skipped
    };
  }

  if (failure) {
    // An unknown provider outcome is never retried — the call may already have
    // been served and billed, and a retry would pay for it twice.
    const retryable = failure.outcomeUnknown
      ? false
      : Boolean(failure?.retryable);

    const result = await failNode({
      nodeId: node.id, leaseId: node.leaseId,
      error: failure.message || "Model node failed",
      retryable, now
    });
    await recordModelPhaseEvent({
      agentInstanceId, taskId: agent.taskId, node,
      status: failure.outcomeUnknown ? "outcome_unknown" : "failed",
      detail: { error: failure.message, retryable }
    });
    return {
      node: result.node,
      status: failure.outcomeUnknown ? "outcome_unknown"
        : result.willRetry ? "retry_scheduled" : "failed",
      error: failure.message,
      outcomeUnknown: Boolean(failure.outcomeUnknown),
      modelResult: failure.modelNodeResult ?? null,
      skipped: result.skipped
    };
  }

  const done = await completeNode({ nodeId: node.id, leaseId: node.leaseId, output, now });
  await recordModelPhaseEvent({
    agentInstanceId, taskId: agent.taskId, node, status: "succeeded",
    detail: { costMinor: output.costMinor, provider: output.provider, model: output.model }
  });

  return {
    node: done.node,
    status: done.accepted ? "succeeded" : "lease_lost",
    unblocked: done.unblocked,
    output,
    modelResult: output,
    // The node succeeded but the provider charged more than the task could
    // account for. Reported alongside the success rather than instead of it.
    budgetOverrun: output.budgetOverrun ?? null
  };
}

function safeParse(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

// ── helpers ─────────────────────────────────────────────────────────────────

// The execution-step states the verifier and the dashboard understand. A node
// status that has no step equivalent must still map to one of these rather than
// leaking a JEV-only word into a record other systems parse.
const NODE_STATUS_AS_STEP_STATE = {
  [NODE_STATUS.SUCCEEDED]: "passed",
  [NODE_STATUS.FAILED]: "failed",
  [NODE_STATUS.TIMED_OUT]: "failed",
  [NODE_STATUS.CANCELLED]: "cancelled",
  [NODE_STATUS.SKIPPED]: "pending",
  [NODE_STATUS.RUNNING]: "running",
  [NODE_STATUS.READY]: "pending",
  [NODE_STATUS.PENDING]: "pending"
};

/**
 * Render a graph node as the execution step other systems expect.
 *
 * The node's original step payload is spread first so every field the planner
 * wrote — path, executable, args, outputDir — is still there for the verifier's
 * artifact extraction; the execution outcome is layered on top.
 */
function nodeAsStep(node) {
  return {
    ...(node.payload || {}),
    id: node.key,
    kind: node.kind,
    state: NODE_STATUS_AS_STEP_STATE[node.status] ?? "pending",
    attempt: node.attempt,
    result: node.output ?? null,
    error: node.error?.message ?? null,
    startedAt: node.startedAt,
    completedAt: node.status === NODE_STATUS.SUCCEEDED ? node.finishedAt : null,
    failedAt: node.status === NODE_STATUS.FAILED || node.status === NODE_STATUS.TIMED_OUT
      ? node.finishedAt
      : null
  };
}

/**
 * What the runtime says the node actually cost, or null when it said nothing.
 *
 * Null is a distinct answer from zero and the caller treats them differently:
 * "no measurement" and "measured, and it was free" justify different
 * settlements.
 */
function measuredSpendMinor(output) {
  const reported = output?.usage?.costMinor;
  if (reported === undefined || reported === null) return null;
  return Math.max(0, Math.trunc(Number(reported) || 0));
}

/**
 * Whether this failure is worth another attempt.
 *
 * Deny by default. Only failures a runtime explicitly marked transient retry;
 * anything unclassified is treated as real, because retrying a deterministic
 * failure just burns the budget three times instead of once.
 */
function isRetryable(error) {
  if (error?.retryable === true) return true;
  if (error?.code === "ETIMEDOUT" || error?.code === "ECONNRESET") return true;
  return false;
}

function runWithTimeout(fn, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return Promise.resolve().then(fn);

  let timer;
  let settled = false;
  const operation = Promise.resolve().then(fn).finally(() => {
    settled = true;
    if (timer) clearTimeout(timer);
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      const error = new Error("Node execution timed out");
      error.retryable = false;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]);
}
