import { loadDb, transact, id } from "./store.js";
import { AGENT_STATUS, TASK_STATUS } from "./domain.js";
import { getAgent, addAgentMessage, completeAgent } from "./agent-manager.js";
import { checkBudget } from "./budget-manager.js";
import { advanceModelGraph, MODEL_LOOP_OUTCOME } from "./jev-model-loop.js";
import { USER_DASHBOARD_STATUS } from "./dashboard.js";
import { ModelRuntimeError } from "./model-runtime.js";
import { readNumberEnv } from "./adapters/model-json.js";

// The autonomous development loop.
//
// Everything else in this repository is a capability: a planner, an executor, a
// verifier, a budget. This file is the thing that actually drives them, and it
// is deliberately a state machine over persisted state rather than an in-memory
// driver — a worker can die between any two transitions and the next tick picks
// the task up exactly where it stopped.
//
// Since model phases became graph nodes there is only ONE schedule, and it is
// the graph's:
//
//   astra-plan -> fable-implement -> exec1:* -> astra-review-1
//                                                   |
//                        pass   -> verify (objective) -> model-verify-1 -> done
//                        revise -> fable-repair-1 -> exec2:* -> astra-review-2
//                        block  -> DECISION NEEDED (stop)
//
// The loop does not decide which phase runs next; it asks the graph, runs at
// most one node, and translates the result into something the user can read.
// One call to advanceAgent() therefore still performs at most one transition,
// so a runaway task remains impossible by construction: progress is bounded by
// how often the coordinator ticks, by the per-node budget reservation, and by
// the configured repair-cycle ceiling.

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

/** Loop stage for a model-graph phase name. */
function stageForPhase(phase) {
  switch (phase) {
    case "plan": return LOOP_STAGE.PLAN;
    case "implement": return LOOP_STAGE.IMPLEMENT;
    case "review": return LOOP_STAGE.REVIEW;
    case "verify": return LOOP_STAGE.VERIFY;
    case "execute": return LOOP_STAGE.EXECUTE;
    default: return LOOP_STAGE.IDLE;
  }
}

/**
 * Finish a task whose work passed objective verification.
 *
 * Verification has already run by the time this is reached — it ran before the
 * model was allowed to interpret it — so this records the completion rather
 * than deciding it.
 */
async function completeVerifiedTask(agent, result) {
  const completed = await completeAgent(agent.id, "Task verified and completed");
  await publishUpdate(
    agent.taskId,
    USER_DASHBOARD_STATUS.COMPLETED,
    "Completed",
    "Everything you asked for is built, tested and verified."
  );
  return {
    stage: LOOP_STAGE.COMPLETED,
    status: "passed",
    agentStatus: completed.status,
    verificationId: result.evidence?.verificationId ?? null,
    viaGraph: true
  };
}

async function advanceAgentUnguarded(agentInstanceId, { orchestrator }) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");

  // Terminal and user-gated states are not the loop's business.
  if (![AGENT_STATUS.RUNNING].includes(agent.status)) {
    return { stage: LOOP_STAGE.IDLE, reason: "Agent status is " + agent.status };
  }

  const db = await loadDb();
  const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
  if (!workspace) throw new Error("Agent workspace not found");

  // The hard budget is checked before the transition, not after it. A task that
  // has already exhausted its ceiling must not reach a provider at all — and
  // each node re-checks its own share inside the graph, so this is the outer
  // gate rather than the only one.
  const budget = await checkBudget(agentInstanceId, EXECUTION_COST);
  if (!budget.allowed) {
    return blockForUser(
      agent,
      "This task has reached its hard budget limit of " + budget.budgetLimit +
        " and cannot run further work. Increase the budget to continue."
    );
  }

  let result;
  try {
    // Every phase — Astra planning, Fable implementing, the tool steps, Astra
    // reviewing, the repair, the verification interpretation — is a node in one
    // graph. The registry comes from the orchestrator because that is where the
    // configured provider adapters live; nothing else about the orchestrator's
    // scheduling is used any more.
    result = await advanceModelGraph(agentInstanceId, {
      modelRegistry: orchestrator.registry,
      workspaceRoot: workspace.path,
      adapters: gameAdapters,
      workerId: "loop:" + agentInstanceId
    });
  } catch (error) {
    // Only a provider that told us it was transient is retried. Everything else
    // reaching here came from our own enforcement — the hard budget, the abuse
    // limits — and retrying that is an infinite loop against a limit that
    // exists precisely to stop us.
    if (error instanceof ModelRuntimeError && error.retryable) {
      return { stage: LOOP_STAGE.IDLE, retryable: true, error: error.message };
    }

    const check = await checkBudget(agentInstanceId, 0);
    if (check.remaining <= 0 || /budget|limit exceeded/i.test(error.message || "")) {
      return blockForUser(
        agent,
        "This task has used its budget of " + check.budgetLimit + " " +
          (agent.task?.currency || "USD") +
          " and has stopped. Increase the budget to let it continue."
      );
    }

    return blockForUser(agent, "The development models could not continue: " + error.message);
  }

  switch (result.outcome) {
    case MODEL_LOOP_OUTCOME.VERIFIED:
      return completeVerifiedTask(agent, result);

    case MODEL_LOOP_OUTCOME.BLOCKED:
    case MODEL_LOOP_OUTCOME.NEEDS_REVIEW:
      return blockForUser(agent, result.reason);

    case MODEL_LOOP_OUTCOME.IDLE:
      return { stage: LOOP_STAGE.IDLE, reason: result.reason || null, graphStatus: result.graphStatus };

    case MODEL_LOOP_OUTCOME.NODE: {
      // Execution noise stays out of the user's conversation; the node record
      // and the audit trail carry the detail.
      if (!result.model) {
        await addAgentMessage(
          agent.id,
          "agent",
          result.status === "succeeded"
            ? "Finished a build step."
            : "Hit a problem while building; reviewing what went wrong.",
          { lowLevel: true, nodeKey: result.nodeKey, status: result.status }
        );
      }
      return {
        stage: stageForPhase(result.phase),
        nodeKey: result.nodeKey,
        kind: result.kind,
        status: result.status,
        error: result.error,
        viaGraph: true
      };
    }

    case MODEL_LOOP_OUTCOME.CREATED:
    case MODEL_LOOP_OUTCOME.EXPANDED:
    default:
      return {
        stage: stageForPhase(result.phase),
        expanded: result.outcome === MODEL_LOOP_OUTCOME.EXPANDED,
        cycle: result.cycle ?? 0,
        viaGraph: true
      };
  }
}

/**
 * Advances every running agent by one transition.
 *
 * One failing agent must not stop the others, so each is isolated: a thrown
 * error is recorded against that agent and the sweep continues.
 */
export async function advanceAllAgents({ orchestrator, skipAgentTypes = [] } = {}) {
  const db = await loadDb();
  const running = db.agentInstances.filter(agent => agent.status === AGENT_STATUS.RUNNING && !skipAgentTypes.includes(agent.agentType));

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
