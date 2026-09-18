import { loadDb, transact, id } from "./store.js";
import { AGENT_STATUS, AGENT_TYPES, TASK_STATUS } from "./domain.js";
import { ORCHESTRATION_STATUS, REVIEW_DECISIONS } from "./orchestrator-domain.js";
import { getAgent, addAgentMessage, completeAgent, failAgent } from "./agent-manager.js";
import { checkBudget, charge } from "./budget-manager.js";
import { readBlackboard, writeBlackboard } from "./blackboard.js";
import { executeAppWebTask } from "./app-web-executor.js";
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

  const executor = agent.agentType === AGENT_TYPES.KONAMI ? executeGameTask : executeAppWebTask;

  let result;
  try {
    result = await executor({
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

/**
 * Performs at most one transition for one agent.
 *
 * Returns what it did, so the coordinator can log a tick without inspecting the
 * database again. Never throws for an ordinary model or execution failure —
 * those become recorded state the next transition can act on.
 */
export async function advanceAgent(agentInstanceId, { orchestrator } = {}) {
  if (!orchestrator) throw new Error("A model orchestrator is required");

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
    const plan = blackboardValue(entries, "execution.plan");
    const lastResult = blackboardValue(entries, "execution.lastResult");
    const planIsFresh = !lastResult || lastResult.planId !== (plan?.id ?? null);

    if (plan && planIsFresh) {
      const attempts = Number(blackboardValue(entries, "execution.attempts") || 0);
      if (attempts >= MAX_EXECUTION_ATTEMPTS) {
        return blockForUser(
          agent,
          "This task has failed to build " + attempts + " times and needs your input before trying again."
        );
      }
      await writeBlackboard(agentInstanceId, "execution.attempts", attempts + 1, "autonomous-loop");
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
    await writeBlackboard(agentInstanceId, "execution.lastResult", null, "autonomous-loop");
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
