import { transact, id } from "./store.js";
import { getAgent } from "./agent-manager.js";
import { profileForAgent } from "./jev-profiles.js";
import { tenantForTask } from "./tenant-security.js";
import { graphForTask } from "./jev.js";
import { executeNextNode, syncExecutionCycleRun } from "./jev-executor.js";
import { writeBlackboard } from "./blackboard.js";
import { verifyTask } from "./verification.js";
import { ORCHESTRATION_STATUS } from "./orchestrator-domain.js";
import { MODEL_NODE_KINDS, isModelNodeKind } from "./jev-model-domain.js";
import {
  createModelGraphForAgent,
  expandWithExecutionPlan,
  expandWithRepair,
  expandWithVerify,
  maxRepairCycles,
  nextModelGraphAction
} from "./jev-model-graph.js";

// Driving the model graph from the live loop.
//
// The previous arrangement had two schedulers: the orchestrator decided which
// model phase ran next and kept that decision in its own run record, while JEV
// decided which workspace node ran next. The model half had no leases, no
// reservations and no durable attempt history, so everything the graph
// guarantees — recovery, one settlement per node, reserve-before-spend — did
// not apply to the expensive half of the work.
//
// This file removes the second scheduler. It does not add one: it reads the
// graph, runs at most one node, and when nothing is claimable asks the graph
// itself what shape it should grow into next. Every decision comes from durable
// node state, so a worker that dies between any two calls is replaced by one
// that reaches the same conclusion.
//
// It decides nothing the existing systems already decide. Budget is billing.js
// through jev-budget. Tool authorization is the broker. Verification is
// verification.js, and its verdict is objective — the model verify node
// interprets that record and cannot overturn it.

export const MODEL_LOOP_OUTCOME = {
  CREATED: "created",
  NODE: "node",
  EXPANDED: "expanded",
  VERIFIED: "verified",
  BLOCKED: "blocked",
  NEEDS_REVIEW: "needs_review",
  IDLE: "idle"
};

/** The loop-facing phase a node belongs to. */
export function phaseForNodeKind(kind) {
  switch (kind) {
    case MODEL_NODE_KINDS.MODEL_PLAN:
    case MODEL_NODE_KINDS.MODEL_ANALYSIS:
    case MODEL_NODE_KINDS.MODEL_REPLAN:
      return "plan";
    case MODEL_NODE_KINDS.MODEL_IMPLEMENT:
    case MODEL_NODE_KINDS.MODEL_REPAIR:
      return "implement";
    case MODEL_NODE_KINDS.MODEL_REVIEW:
      return "review";
    case MODEL_NODE_KINDS.MODEL_VERIFY:
      return "verify";
    default:
      return "execute";
  }
}

/**
 * Keep the orchestration run record in step with the graph.
 *
 * The record is no longer a scheduler — the graph is — but it is what the
 * handoff path in reliability.js reads when a task moves between agents, and
 * what an operator looks at to see which phase a task is in. It is a projection
 * of graph state, written after the fact, never consulted to decide what runs.
 */
async function syncRun(agentInstanceId, patch) {
  return transact(db => {
    let run = db.orchestrationRuns.find(x => x.agentInstanceId === agentInstanceId);
    const stamp = new Date().toISOString();
    if (!run) {
      run = {
        id: id("orch"),
        agentInstanceId,
        status: ORCHESTRATION_STATUS.READY,
        cycle: 0,
        phase: null,
        contextVersion: 1,
        contextCompactions: 0,
        lastDecision: null,
        lastError: null,
        createdAt: stamp,
        updatedAt: stamp
      };
      db.orchestrationRuns.push(run);
    }
    Object.assign(run, patch, { driver: "jev", updatedAt: stamp });
    return run;
  });
}

/**
 * Perform at most one model-graph transition for one agent.
 *
 * "At most one" is the contract advanceAgent has always had: progress is
 * bounded by how often the coordinator ticks rather than by a loop in here, so
 * a task cannot run away and a caller can always interleave.
 */
export async function advanceModelGraph(agentInstanceId, {
  modelRegistry,
  workspaceRoot,
  adapters = {},
  workerId = null,
  now = new Date()
} = {}) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");
  const profile = profileForAgent(agent);
  const tenantId = await tenantForTask(agent.taskId);

  // The graph itself.
  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  if (!view) {
    const created = await createModelGraphForAgent(agentInstanceId, { now });
    await syncRun(agentInstanceId, {
      status: ORCHESTRATION_STATUS.PLANNING,
      phase: ORCHESTRATION_STATUS.PLANNING
    });
    return {
      outcome: MODEL_LOOP_OUTCOME.CREATED,
      phase: "plan",
      graphId: created.graph.id,
      nodes: created.nodes.length
    };
  }

  if (view.graph.status === "cancelled") {
    return {
      outcome: MODEL_LOOP_OUTCOME.IDLE,
      reason: "The task graph was cancelled",
      graphId: view.graph.id
    };
  }

  // One node.
  const result = await executeNextNode({
    agentInstanceId,
    workspaceRoot,
    adapters,
    modelRegistry,
    taskId: agent.taskId,
    tenantId,
    workerId: workerId || "loop:" + agentInstanceId,
    now
  });

  if (result) {
    return settleNodeResult({ agentInstanceId, profile, result, graphId: view.graph.id });
  }

  // Nothing claimable: what should the graph become?
  const action = await nextModelGraphAction({ taskId: agent.taskId, tenantId });

  switch (action.action) {
    case "expand-execution":
      return expandExecution({ agentInstanceId, agent, action, now });
    case "expand-repair":
      return expandRepair({ agentInstanceId, action, now });
    case "repair-limit":
      return repairLimitReached({ agentInstanceId, action });
    case "expand-verify":
      return expandVerify({ agentInstanceId, action, now });
    case "verified":
      return settleVerification({ agentInstanceId, agent, tenantId, action, now });
    case "block":
      await syncRun(agentInstanceId, { status: ORCHESTRATION_STATUS.BLOCKED, lastError: action.reason });
      return {
        outcome: MODEL_LOOP_OUTCOME.BLOCKED,
        phase: "review",
        reason: action.reason || "The review blocked this task pending a decision from you.",
        graphId: action.graphId
      };
    default:
      break;
  }

  // A graph with nothing claimable and nothing to expand has either finished
  // without a verdict or failed. Failure is reported rather than silently
  // idling, which is the state that used to hang a task forever.
  if (view.graph.status === "failed") {
    const failed = view.nodes.filter(node => ["failed", "timed_out"].includes(node.status));
    const reason = failed.length
      ? "The build could not be completed: " +
        failed.map(n => n.key + " (" + (n.lastError || n.status) + ")").join("; ")
      : "The build could not be completed.";
    await syncRun(agentInstanceId, { status: ORCHESTRATION_STATUS.FAILED, lastError: reason });
    return { outcome: MODEL_LOOP_OUTCOME.BLOCKED, phase: "execute", reason, graphId: view.graph.id };
  }

  return { outcome: MODEL_LOOP_OUTCOME.IDLE, graphId: view.graph.id, graphStatus: view.graph.status };
}

/**
 * Turn one node's execution into a loop outcome.
 *
 * Two outcomes are deliberately terminal rather than retried:
 *
 *   budget_refused    came from our own ceiling. Retrying spins against a limit
 *                     that exists to stop us.
 *   outcome_unknown   the provider may already have been paid. A second call
 *                     would pay twice, so it stops for reconciliation.
 */
async function settleNodeResult({ agentInstanceId, profile, result, graphId }) {
  const node = result.node;
  const phase = phaseForNodeKind(node.kind);

  if (result.status === "budget_refused") {
    await syncRun(agentInstanceId, {
      status: ORCHESTRATION_STATUS.BLOCKED,
      phase,
      lastError: result.reason
    });
    return {
      outcome: MODEL_LOOP_OUTCOME.BLOCKED,
      phase,
      budget: true,
      limit: result.limit,
      reason: "This task ran out of budget at " + node.key + " (" + result.reason +
        "). The work completed so far is kept. Increase the budget to continue.",
      graphId
    };
  }

  if (result.status === "outcome_unknown") {
    await writeBlackboard(
      agentInstanceId,
      "model.reconciliation.pending",
      {
        nodeKey: node.key,
        kind: node.kind,
        attempt: node.attempt,
        provider: result.modelResult?.provider ?? null,
        model: result.modelResult?.model ?? null,
        reservedMinor: result.modelResult?.reservedMinor ?? null,
        detectedAt: new Date().toISOString()
      },
      "jev-model-loop"
    );
    await syncRun(agentInstanceId, {
      status: ORCHESTRATION_STATUS.BLOCKED,
      phase,
      lastError: result.error
    });
    return {
      outcome: MODEL_LOOP_OUTCOME.BLOCKED,
      phase,
      outcomeUnknown: true,
      reason: "A model provider stopped responding after the request had been sent, so it is not known " +
        "whether that call completed and was charged. This task has stopped rather than repeat it. " +
        "Reconcile the provider's record for " + node.key + " before resuming.",
      graphId
    };
  }

  if (result.budgetOverrun) {
    await syncRun(agentInstanceId, {
      status: ORCHESTRATION_STATUS.BLOCKED,
      phase,
      lastError: "Model spend exceeded the task budget"
    });
    return {
      outcome: MODEL_LOOP_OUTCOME.BLOCKED,
      phase,
      budget: true,
      reason: "A model call for " + node.key + " cost more than this task's remaining budget. " +
        "Its result has been kept, and the task has stopped rather than start work it cannot pay for. " +
        "Increase the budget to continue.",
      graphId
    };
  }

  const succeeded = result.status === "succeeded";

  // An execution node changes what the cycle's run record says, and the review
  // that follows reads that record. Recording it here — not at the end of a
  // drain that no longer exists — is what keeps verification and review looking
  // at real evidence.
  const cycleMatch = /^exec(\d+):/.exec(node.key);
  if (cycleMatch) {
    await syncExecutionCycleRun({ agentInstanceId, cycle: Number(cycleMatch[1]) });
  }

  await syncRun(agentInstanceId, {
    status: succeeded
      ? (phase === "review" ? ORCHESTRATION_STATUS.REVIEWING : ORCHESTRATION_STATUS.IMPLEMENTING)
      : ORCHESTRATION_STATUS.ITERATING,
    phase: phase === "plan" ? ORCHESTRATION_STATUS.PLANNING
      : phase === "review" ? ORCHESTRATION_STATUS.REVIEWING
      : ORCHESTRATION_STATUS.IMPLEMENTING,
    lastError: succeeded ? null : (result.error || null)
  });

  if (!succeeded && result.error) {
    await writeBlackboard(
      agentInstanceId,
      profile.keys.lastResult,
      { status: "failed", nodeKey: node.key, error: result.error },
      "jev-model-loop"
    );
  }

  return {
    outcome: MODEL_LOOP_OUTCOME.NODE,
    phase,
    nodeKey: node.key,
    kind: node.kind,
    model: isModelNodeKind(node.kind),
    status: result.status,
    error: result.error || null,
    graphId
  };
}

async function expandExecution({ agentInstanceId, agent, action, now }) {
  const plan = action.implementNode?.output?.structured?.plan ?? null;
  if (!plan) {
    // An implementation that produced no plan is a real failure, not something
    // to retry: there is nothing for the execution nodes to be built from.
    await syncRun(agentInstanceId, {
      status: ORCHESTRATION_STATUS.BLOCKED,
      lastError: "The implementation produced no execution plan"
    });
    return {
      outcome: MODEL_LOOP_OUTCOME.BLOCKED,
      phase: "implement",
      reason: "The implementation step did not produce a plan that can be executed.",
      graphId: action.graphId
    };
  }

  try {
    const expanded = await expandWithExecutionPlan({
      graphId: action.graphId, plan, agent, cycle: action.cycle, now
    });
    return {
      outcome: MODEL_LOOP_OUTCOME.EXPANDED,
      phase: "execute",
      cycle: action.cycle,
      added: expanded.nodes?.length ?? 0,
      graphId: action.graphId
    };
  } catch (error) {
    await syncRun(agentInstanceId, { status: ORCHESTRATION_STATUS.BLOCKED, lastError: error.message });
    return {
      outcome: MODEL_LOOP_OUTCOME.BLOCKED,
      phase: "implement",
      reason: "The plan produced by the implementation could not be turned into executable steps: " +
        error.message,
      graphId: action.graphId
    };
  }
}

async function expandRepair({ agentInstanceId, action, now }) {
  await expandWithRepair({
    graphId: action.graphId, reviewKey: action.reviewKey, cycle: action.cycle, now
  });
  await syncRun(agentInstanceId, {
    status: ORCHESTRATION_STATUS.ITERATING,
    cycle: action.cycle,
    lastDecision: "revise"
  });
  return {
    outcome: MODEL_LOOP_OUTCOME.EXPANDED,
    phase: "implement",
    cycle: action.cycle,
    repair: true,
    graphId: action.graphId
  };
}

function findingText(finding) {
  if (typeof finding === "string") return finding;
  return finding?.detail || finding?.summary || finding?.reason || null;
}

async function repairLimitReached({ agentInstanceId, action }) {
  await syncRun(agentInstanceId, {
    status: ORCHESTRATION_STATUS.BLOCKED,
    cycle: action.cycle,
    lastDecision: "revise",
    lastError: "Repair cycle limit reached"
  });

  const findings = (action.findings || []).map(findingText).filter(Boolean).slice(0, 5);

  return {
    outcome: MODEL_LOOP_OUTCOME.NEEDS_REVIEW,
    phase: "review",
    cycle: action.cycle,
    limit: action.limit,
    reason: "This task has been through " + action.cycle + " repair cycles, which is the configured limit of " +
      action.limit + ", and the review still asks for changes. It has stopped for you to look at rather than " +
      "spending more on another attempt." +
      (findings.length ? " Outstanding: " + findings.join("; ") : ""),
    graphId: action.graphId
  };
}

/**
 * Run the objective verifier, then create the node that interprets its record.
 *
 * Deliberately in this order. The evidence exists before the model is asked
 * about it, which is what stops the interpretation from becoming the evidence.
 */
async function expandVerify({ agentInstanceId, action, now }) {
  const verification = await verifyTask(agentInstanceId);
  const evidence = {
    verificationId: verification.id,
    status: verification.status,
    executionRunId: verification.executionRunId ?? null,
    checks: (verification.checks || []).map(check => ({
      key: check.key,
      passed: check.passed,
      category: check.category ?? null,
      reason: check.reason ?? null
    })),
    failures: verification.failures || [],
    verifiedAt: verification.createdAt
  };

  await writeBlackboard(agentInstanceId, "verification.evidence", evidence, "jev-model-loop");

  await expandWithVerify({
    graphId: action.graphId, reviewKey: action.reviewKey, cycle: action.cycle, evidence, now
  });

  return {
    outcome: MODEL_LOOP_OUTCOME.EXPANDED,
    phase: "verify",
    cycle: action.cycle,
    verificationStatus: verification.status,
    graphId: action.graphId
  };
}

/**
 * The verification node has run. Decide what its evidence means.
 *
 * The objective record decides, not the model. A model that says "passed" over
 * a failing verification changes nothing here; its interpretation is stored as
 * commentary and the task goes back for repair.
 */
async function settleVerification({ agentInstanceId, agent, tenantId, action, now }) {
  const evidence = action.evidence;

  if (evidence?.status === "passed") {
    await syncRun(agentInstanceId, {
      status: ORCHESTRATION_STATUS.COMPLETED,
      phase: ORCHESTRATION_STATUS.REVIEWING,
      lastDecision: "pass",
      lastError: null
    });
    return {
      outcome: MODEL_LOOP_OUTCOME.VERIFIED,
      phase: "verify",
      cycle: action.cycle,
      evidence,
      interpretation: action.interpretation ?? null,
      graphId: action.graphId
    };
  }

  // Verification failed. Recorded so the next review cycle sees exactly which
  // check failed, exactly as the previous loop did.
  await writeBlackboard(
    agentInstanceId,
    "verification.lastFailure",
    { failures: evidence?.failures ?? [], verifiedAt: evidence?.verifiedAt ?? null },
    "jev-model-loop"
  );

  const repairKey = "fable-repair-" + action.cycle;
  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  const repairExists = Boolean(view?.nodes.some(node => node.key === repairKey));

  if (repairExists || action.cycle >= maxRepairCycles()) {
    await syncRun(agentInstanceId, {
      status: ORCHESTRATION_STATUS.BLOCKED,
      cycle: action.cycle,
      lastError: "Verification failed and no further repair is available"
    });
    const reasons = (evidence?.failures ?? []).map(f => f.reason).filter(Boolean);
    return {
      outcome: MODEL_LOOP_OUTCOME.NEEDS_REVIEW,
      phase: "verify",
      cycle: action.cycle,
      failures: evidence?.failures ?? [],
      reason: "The work was reviewed as complete but did not pass verification, and no further repair " +
        "attempt is available. Failed checks: " + (reasons.join("; ") || "unspecified") + ".",
      graphId: action.graphId
    };
  }

  await expandWithRepair({
    graphId: action.graphId,
    reviewKey: "model-verify-" + action.cycle,
    cycle: action.cycle,
    now
  });
  await syncRun(agentInstanceId, {
    status: ORCHESTRATION_STATUS.ITERATING,
    cycle: action.cycle,
    lastError: "Verification failed after a passing review"
  });

  return {
    outcome: MODEL_LOOP_OUTCOME.EXPANDED,
    phase: "implement",
    cycle: action.cycle,
    repair: true,
    afterVerificationFailure: true,
    graphId: action.graphId
  };
}
