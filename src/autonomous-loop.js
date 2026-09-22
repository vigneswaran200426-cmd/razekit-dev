import { loadDb, transact, id } from "./store.js";
import { AGENT_STATUS, AGENT_TYPES, TASK_STATUS } from "./domain.js";
import { ORCHESTRATION_STATUS, REVIEW_DECISIONS } from "./orchestrator-domain.js";
import { getAgent, addAgentMessage, completeAgent, failAgent } from "./agent-manager.js";
import { checkBudget, charge } from "./budget-manager.js";
import { readBlackboard, writeBlackboard } from "./blackboard.js";
import { executeAppWebTask } from "./app-web-executor.js";
import { normalizeModelExecutionPlan } from "./app-web-domain.js";
import { createGraphForAgent, drainGraph } from "./jev-executor.js";
import { cancelGraph, graphForTask } from "./jev.js";
import { profileForAgent } from "./jev-profiles.js";
import { tenantForTask } from "./tenant-security.js";
import { executeGameTask } from "./game-executor.js";
import { verifyTask } from "./verification.js";
import { USER_DASHBOARD_STATUS } from "./dashboard.js";
import { ModelRuntimeError } from "./model-runtime.js";
import { readNumberEnv } from "./adapters/model-json.js";

// The autonomous development loop.
//
// Everything else in this repository is a capability: a planner, an executor, a
// verifier, a budget. This file is the thing that actually drives them, and it
// is deliberately a state machine over persisted state rather than an
// in-memory driver — a worker can die between any two transitions and the next
// tick picks the task up exactly where it stopped.
//
//   PLAN (Astra) -> IMPLEMENT (Fable) -> EXECUTE (tools) -> REVIEW (Astra)
//                                                            |
//                          pass -> VERIFY -> COMPLETED       |
//                          revise -> back to IMPLEMENT  <----+
//                          block  -> DECISION NEEDED (stop)
//
// One call to advanceAgent() performs at most one transition. Nothing here
// loops internally, so a runaway task is impossible by construction: progress
// is bounded by how often the coordinator ticks, and by the budget and review
// ceilings that each transition re-checks.

export const LOOP_STAGE = {
  PLAN: "plan",
  IMPLEMENT: "implement",
  EXECUTE: "execute",
  REVIEW: "review",
  VERIFY: "verify",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  IDLE: "idle"
};

// Execution consumes real worker time. The rate is configuration rather than a
// constant because it depends on what the operator's workers cost; at the
// default of zero, execution is free but still budget-*checked*, so a task that
// has already exhausted its budget cannot run one more build.
const EXECUTION_COST = readNumberEnv("RAZEKIT_EXECUTION_RUN_COST", 0);

const MAX_EXECUTION_ATTEMPTS = readNumberEnv("RAZEKIT_MAX_EXECUTION_ATTEMPTS", 3);

// Game engine, playtest and packager adapters for the loop's Konami runs.
//
// Empty by default, which is the honest position: this deployment configures no
// engine toolchain, so an engine or build step fails the way it always has. An
// operator — or a test with deterministic adapters — registers real ones here
// rather than the executor pretending an engine exists.
let gameAdapters = {};

export function configureGameAdapters(adapters = {}) {
  gameAdapters = adapters || {};
  return gameAdapters;
}

function blackboardValue(entries, key) {
  return entries.find(entry => entry.key === key)?.value ?? null;
}

async function publishUpdate(taskId, status, title, message) {
  return transact(db => {
    const update = {
      id: id("update"),
      taskId,
      status,
      title,
      message,
      changeId: null,
      createdAt: new Date().toISOString()
    };
    db.userUpdates.push(update);
    return update;
  });
}

/**
 * Moves a task into DECISION NEEDED and stops the agent there.
 *
 * Blocking is a first-class outcome, not a failure: the work is fine, it just
 * cannot continue without something only the user can give. The agent keeps its
 * workspace and its state so that approving the decision resumes it rather than
 * restarting it.
 */
async function blockForUser(agent, reason) {
  await transact(db => {
    const instance = db.agentInstances.find(x => x.id === agent.id);
    const task = db.tasks.find(x => x.id === agent.taskId);
    if (!instance || !task) return;
    instance.status = AGENT_STATUS.WAITING_USER;
    instance.executionState = "waiting_user";
    task.status = TASK_STATUS.WAITING_USER;
    task.updatedAt = new Date().toISOString();
  });

  await publishUpdate(
    agent.taskId,
    USER_DASHBOARD_STATUS.DECISION_NEEDED,
    "Decision needed",
    reason
  );
  await addAgentMessage(agent.id, "agent", reason, { decision: true });

  return { stage: LOOP_STAGE.BLOCKED, reason };
}

/**
 * Run the current plan as a graph.
 *
 * The plan Fable produced is converted to a JEV graph and drained node by node.
 * Each node holds its own budget before it runs and settles it afterwards, so
 * the hard limit is enforced per step rather than once for the whole build — a
 * plan that runs out of budget half way now stops half way, with the completed
 * half recorded, instead of being charged for work it never did.
 *
 * An active graph is resumed rather than rebuilt. That is what makes a worker
 * death mid-build recoverable: the next tick picks up the nodes that have not
 * succeeded and leaves the ones that have.
 */
async function runGraphExecution(agent, workspace, adapters = {}) {
  const profile = profileForAgent(agent);
  const tenantId = await tenantForTask(agent.taskId);
  const entries = await readBlackboard(agent.id);

  // Each production system keeps its plan under its own blackboard key, and
  // validates it with its own contract. Reading App/Web's key for a game agent
  // would silently find nothing and rebuild the baseline plan every tick.
  const plan = blackboardValue(entries, profile.keys.plan);
  const planId = (() => {
    try {
      return profile.normalizePlan(plan)?.id ?? null;
    } catch {
      // An unusable stored plan is not a reason to crash the transition; the
      // graph build below will reject it with a message the reviewer can read.
      return null;
    }
  })();

  let existing = await graphForTask({ taskId: agent.taskId, tenantId });

  // A revised plan is a different plan. Leaving the previous graph active would
  // drain yesterday's steps and report them as this plan's result.
  if (existing && planId && existing.graph.planId && existing.graph.planId !== planId) {
    await cancelGraph({ graphId: existing.graph.id, reason: "superseded by a revised plan" });
    existing = null;
  }

  if (!existing) {
    await createGraphForAgent(agent.id, { plan: plan ?? null });
  }

  const result = await drainGraph({
    agentInstanceId: agent.id,
    workspaceRoot: workspace.path,
    adapters,
    workerId: "loop:" + agent.id
  });

  // A graph that stopped because a node could not be afforded is a budget
  // block, not a build failure, and the user needs to be told which it was.
  const refusal = blackboardValue(await readBlackboard(agent.id), profile.keys.lastResult + ".budgetRefusal");
  if (result.status === "failed" && refusal) {
    return blockForUser(
      agent,
      "This task ran out of budget part-way through the build (" + refusal.reason +
        "). The work completed so far is kept. Increase the budget to continue."
    );
  }

  await addAgentMessage(
    agent.id,
    "agent",
    result.status === "completed"
      ? "Finished building and testing this version."
      : "Hit a problem while building; reviewing what went wrong.",
    { lowLevel: true, runId: result.runId, status: result.status, nodes: result.executed?.length ?? 0 }
  );

  return { stage: LOOP_STAGE.EXECUTE, status: result.status, runId: result.runId, viaGraph: true };
}

async function runExecution(agent) {
  const db = await loadDb();
  const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
  if (!workspace) throw new Error("Agent workspace not found");

  // The budget is checked before the work, not after it: a build that overruns
  // the hard limit must not run at all.
  const budget = await checkBudget(agent.id, EXECUTION_COST);
  if (!budget.allowed) {
    return blockForUser(
      agent,
      "This task has reached its hard budget limit of " + budget.budgetLimit +
        " and cannot run further work. Increase the budget to continue."
    );
  }

  // Both production systems now run as graphs. The only thing that differs is
  // the execution profile — which runtime, which blackboard keys, which plan
  // contract — and that is resolved from the agent rather than branched here.
  //
  // Game engine/playtest/packager adapters are supplied by the caller exactly
  // as the flat executor required. The loop configures none, so an engine or
  // build step fails with the same "No game engine adapter is configured" it
  // has always failed with; moving onto JEV does not invent engine support.
  try {
    return await runGraphExecution(agent, workspace, gameAdapters);
  } catch (error) {
    const profile = profileForAgent(agent);
    await writeBlackboard(
      agent.id,
      profile.keys.lastResult,
      { status: "failed", error: error.message || "Graph execution failed to start" },
      "autonomous-loop"
    );
    return { stage: LOOP_STAGE.EXECUTE, status: "failed", error: error.message };
  }
}

// Retained so an operator or a test can run a game task through the previous
// flat path while the graph path beds in. The live loop no longer calls it.
export async function runFlatGameExecution(agent, workspace) {
  let result;
  try {
    result = await executeGameTask({
      agentInstanceId: agent.id,
      workspaceRoot: workspace.path,
      plan: null
    });
  } catch (error) {
    // A plan that cannot even start (invalid steps, missing workspace) is
    // evidence for the reviewer, not a crash: Astra reads it and decides
    // whether Fable can fix it.
    await writeBlackboard(
      agent.id,
      "execution.lastResult",
      { status: "failed", error: error.message || "Execution failed to start" },
      "autonomous-loop"
    );
    return { stage: LOOP_STAGE.EXECUTE, status: "failed", error: error.message };
  }

  if (EXECUTION_COST > 0) {
    await charge(agent.id, EXECUTION_COST, "execution:" + result.runId);
  }

  await addAgentMessage(
    agent.id,
    "agent",
    result.status === "completed"
      ? "Finished building and testing this version."
      : "Hit a problem while building; reviewing what went wrong.",
    // Marked low-level so the dashboard's chat projection keeps step-by-step
    // execution noise out of the user's conversation.
    { lowLevel: true, runId: result.runId, status: result.status }
  );

  return { stage: LOOP_STAGE.EXECUTE, status: result.status, runId: result.runId };
}

async function runVerification(agent) {
  const verification = await verifyTask(agent.id);

  if (verification.status !== "passed") {
    // Astra said pass; objective verification disagreed. Verification wins —
    // that is the entire point of section 17. The disagreement is recorded so
    // the next review cycle sees exactly which check failed.
    await writeBlackboard(
      agent.id,
      "verification.lastFailure",
      { failures: verification.failures, verifiedAt: verification.createdAt },
      "autonomous-loop"
    );
    await transact(db => {
      const run = db.orchestrationRuns.find(x => x.agentInstanceId === agent.id);
      if (!run) return;
      run.status = ORCHESTRATION_STATUS.ITERATING;
      run.cycle += 1;
      run.lastError = "Verification failed after a passing review";
      run.updatedAt = new Date().toISOString();
    });
    return { stage: LOOP_STAGE.VERIFY, status: "failed", failures: verification.failures };
  }

  const completed = await completeAgent(agent.id, "Task verified and completed");
  await publishUpdate(
    agent.taskId,
    USER_DASHBOARD_STATUS.COMPLETED,
    "Completed",
    "Everything you asked for is built, tested and verified."
  );

  return { stage: LOOP_STAGE.COMPLETED, status: "passed", agentStatus: completed.status };
}

// Agents currently mid-transition in this process.
//
// A transition can take minutes — a test suite, a build — while the coordinator
// ticks on a much shorter interval and an operator can hit the advance endpoint
// at any moment. Two transitions for one agent would run two executions
// concurrently in one workspace and race each other's state writes, so a second
// caller is told the agent is busy rather than being allowed to start.
const inFlight = new Set();

/**
 * Performs at most one transition for one agent.
 *
 * Returns what it did, so the coordinator can log a tick without inspecting the
 * database again. Never throws for an ordinary model or execution failure —
 * those become recorded state the next transition can act on.
 */
export async function advanceAgent(agentInstanceId, { orchestrator } = {}) {
  if (!orchestrator) throw new Error("A model orchestrator is required");
  if (inFlight.has(agentInstanceId)) {
    return { stage: LOOP_STAGE.IDLE, busy: true, reason: "A transition is already running for this agent" };
  }

  inFlight.add(agentInstanceId);
  try {
    return await advanceAgentUnguarded(agentInstanceId, { orchestrator });
  } finally {
    inFlight.delete(agentInstanceId);
  }
}

async function advanceAgentUnguarded(agentInstanceId, { orchestrator }) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");

  // Terminal and user-gated states are not the loop's business.
  if (![AGENT_STATUS.RUNNING].includes(agent.status)) {
    return { stage: LOOP_STAGE.IDLE, reason: "Agent status is " + agent.status };
  }

  const state = await orchestrator.getState(agentInstanceId);
  const run = state.run;
  const entries = await readBlackboard(agentInstanceId);

  // ── Completed orchestration: verify, then finish ────────────────────────────
  if (run?.status === ORCHESTRATION_STATUS.COMPLETED) {
    return runVerification(agent);
  }

  if (run?.status === ORCHESTRATION_STATUS.FAILED) {
    await failAgent(agentInstanceId, run.lastError || "Model orchestration failed");
    return { stage: LOOP_STAGE.BLOCKED, reason: run.lastError };
  }

  // ── Between Fable and Astra: run what Fable produced ───────────────────────
  //
  // The orchestrator hands off at phase=implementing/status=reviewing. Review
  // must not happen until the plan has actually run, or Astra would be
  // reviewing an intention rather than a result.
  if (run?.phase === ORCHESTRATION_STATUS.IMPLEMENTING &&
      run.status === ORCHESTRATION_STATUS.REVIEWING) {
    // Each production system keeps its plan and its last result under its own
    // keys. Reading App/Web's keys for a game agent finds nothing, so the gate
    // never fires and the task loops between implement and review forever.
    const keys = profileForAgent(agent).keys;
    const plan = blackboardValue(entries, keys.plan);
    const lastResult = blackboardValue(entries, keys.lastResult);
    const planIsFresh = !lastResult || lastResult.planId !== (plan?.id ?? null);

    if (plan && planIsFresh) {
      const attempts = Number(blackboardValue(entries, keys.plan + ".attempts") || 0);
      if (attempts >= MAX_EXECUTION_ATTEMPTS) {
        return blockForUser(
          agent,
          "This task has failed to build " + attempts + " times and needs your input before trying again."
        );
      }
      await writeBlackboard(agentInstanceId, keys.plan + ".attempts", attempts + 1, "autonomous-loop");
      return runExecution(agent);
    }
  }

  // ── Otherwise: take the next model step ───────────────────────────────────
  let stepResult;
  try {
    stepResult = await orchestrator.step(agentInstanceId);
  } catch (error) {
    // Only a provider that told us it was transient is retried. Everything else
    // reaching here came from our own enforcement — the hard budget, the abuse
    // limits — and retrying that is an infinite loop against a limit that
    // exists precisely to stop us.
    const retryable = error instanceof ModelRuntimeError && error.retryable;
    if (retryable) {
      // The orchestrator left the run blocked-but-retryable; the next tick
      // repeats the same phase. Bounded by MAX_REVIEW_CYCLES and the budget.
      return { stage: LOOP_STAGE.IDLE, retryable: true, error: error.message };
    }

    const budget = await checkBudget(agentInstanceId, 0);
    if (budget.remaining <= 0 || /budget|limit exceeded/i.test(error.message || "")) {
      return blockForUser(
        agent,
        "This task has used its budget of " + budget.budgetLimit + " " +
          (agent.task?.currency || "USD") +
          " and has stopped. Increase the budget to let it continue."
      );
    }

    return blockForUser(
      agent,
      "The development models could not continue: " + error.message
    );
  }

  const updated = stepResult.run;
  const decision = stepResult.result?.review?.decision;

  if (decision === REVIEW_DECISIONS.BLOCK) {
    return blockForUser(
      agent,
      stepResult.result.review.blockedOn ||
        stepResult.result.review.reason ||
        "This task needs a decision from you before it can continue."
    );
  }

  if (updated?.status === ORCHESTRATION_STATUS.BLOCKED) {
    return blockForUser(agent, updated.lastError || "The task cannot continue without your input.");
  }

  // A passing review does NOT complete the task here. It ends this transition
  // with the orchestration marked complete, and the next one runs verification
  // — so "Astra approved" and "the work was objectively verified" stay two
  // separate, separately auditable events.
  if (updated?.status === ORCHESTRATION_STATUS.COMPLETED) {
    return {
      stage: LOOP_STAGE.REVIEW,
      orchestrationStatus: updated.status,
      reviewDecision: REVIEW_DECISIONS.PASS
    };
  }

  // A revise verdict clears the execution guard so the next plan really runs
  // instead of being skipped as already-executed.
  if (decision === REVIEW_DECISIONS.REVISE) {
    await writeBlackboard(
      agentInstanceId,
      profileForAgent(agent).keys.lastResult,
      null,
      "autonomous-loop"
    );
  }

  // `phase` is the phase that just ran, which is what the stage names.
  const stage =
    updated?.phase === ORCHESTRATION_STATUS.PLANNING ? LOOP_STAGE.PLAN :
    updated?.phase === ORCHESTRATION_STATUS.IMPLEMENTING ? LOOP_STAGE.IMPLEMENT :
    updated?.phase === ORCHESTRATION_STATUS.REVIEWING ? LOOP_STAGE.REVIEW :
    LOOP_STAGE.IDLE;

  return {
    stage,
    orchestrationStatus: updated?.status || null,
    reviewDecision: decision || null,
    cycle: updated?.cycle ?? 0
  };
}

/**
 * Advances every running agent by one transition.
 *
 * One failing agent must not stop the others, so each is isolated: a thrown
 * error is recorded against that agent and the sweep continues.
 */
export async function advanceAllAgents({ orchestrator } = {}) {
  const db = await loadDb();
  const running = db.agentInstances.filter(agent => agent.status === AGENT_STATUS.RUNNING);

  const results = [];
  for (const agent of running) {
    try {
      results.push({ agentInstanceId: agent.id, ...(await advanceAgent(agent.id, { orchestrator })) });
    } catch (error) {
      results.push({
        agentInstanceId: agent.id,
        stage: LOOP_STAGE.IDLE,
        error: error.message || "Agent transition failed"
      });
    }
  }
  return results;
}
