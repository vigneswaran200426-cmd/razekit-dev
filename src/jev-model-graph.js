import { loadDb } from "./store.js";
import { getAgent } from "./agent-manager.js";
import { createTaskGraph, expandGraph, graphForTask } from "./jev.js";
import { tenantForTask } from "./tenant-security.js";
import { profileForAgent } from "./jev-profiles.js";
import { graphFromExecutionPlan } from "./jev-planner.js";
import { majorToMinor } from "./jev-budget.js";
import { readNumberEnv } from "./adapters/model-json.js";
import {
  MODEL_NODE_KINDS,
  agentForModelKind,
  estimateModelNodeCostMinor,
  promptForModelKind,
  REVIEW_OUTCOMES
} from "./jev-model-domain.js";

// Building the graph that contains the model phases.
//
// The shape cannot be known up front, and that is the whole reason expandGraph
// exists. At creation time only this much is true:
//
//   MODEL_PLAN -> MODEL_IMPLEMENT -> MODEL_REVIEW
//
// What the implementation actually does is whatever plan Fable returns, so the
// execution nodes are appended once that plan exists. Whether a repair happens
// at all depends on what the review decides, so the repair branch is appended
// only when it is needed — which is also what stops a repair budget being
// reserved for a repair that never occurs (section 23).

function modelBaseCostMinor() {
  // Reuses the same knob the execution nodes use. Zero by default, so a
  // deployment that has not priced its models reserves nothing and the budget
  // binds by being checked rather than consumed.
  return majorToMinor(readNumberEnv("RAZEKIT_MODEL_NODE_COST", 0));
}

/**
 * Describe a model node for the graph.
 *
 * `budgetMinor` is the reservation ceiling, taken from the estimate's maximum:
 * a reservation that is too small stops work that could have been afforded, and
 * whatever is not used is released rather than charged.
 */
function modelNode(kind, { key, dependsOn = [], complexity = 1, maxAttempts = 2, timeoutMs = 0 } = {}) {
  const estimate = estimateModelNodeCostMinor(kind, { baseMinor: modelBaseCostMinor(), complexity });
  return {
    key: key || kind.replace(/_/g, "-"),
    kind,
    description: promptForModelKind(kind),
    dependsOn,
    payload: {
      agent: agentForModelKind(kind),
      kind,
      prompt: promptForModelKind(kind),
      estimate,
      // An implementation produces the plan that becomes the execution nodes.
      // Until those exist the graph is not finished, even though every node in
      // it has succeeded — see awaitsExpansion in jev-domain.
      expandsGraph: kind === MODEL_NODE_KINDS.MODEL_IMPLEMENT || kind === MODEL_NODE_KINDS.MODEL_REPAIR
    },
    maxAttempts,
    timeoutMs,
    budgetMinor: estimate.maximumMinor,
    // A model node authors work; it does not run commands itself. Whatever it
    // then asks to do goes through the tool broker under the execution nodes'
    // scopes, so the model node itself declares none.
    toolScopes: []
  };
}

/**
 * Create the task's graph with the model phases in it.
 *
 * Returns the graph and its initial nodes. Nothing is executed here.
 */
export async function createModelGraphForAgent(agentInstanceId, { now = new Date() } = {}) {
  const agent = await getAgent(agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");

  const db = await loadDb();
  const task = db.tasks.find(item => item.id === agent.taskId);
  if (!task) throw new Error("Task not found");

  const tenantId = await tenantForTask(agent.taskId);

  // Only the two nodes whose dependencies are known. The review is NOT created
  // here: a review node depending on the implementation would become claimable
  // the moment the implementation finished, and would therefore review an
  // intention rather than a result. It is appended alongside the execution
  // nodes it reviews, by expandWithExecutionPlan.
  const nodes = [
    modelNode(MODEL_NODE_KINDS.MODEL_PLAN, { key: "astra-plan" }),
    modelNode(MODEL_NODE_KINDS.MODEL_IMPLEMENT, { key: "fable-implement", dependsOn: ["astra-plan"], complexity: 1 })
  ];

  return createTaskGraph({
    tenantId,
    userId: task.userId || "local-user",
    taskId: agent.taskId,
    agentInstanceId,
    planId: null,
    nodes,
    now
  });
}

/**
 * Append the execution nodes for whatever plan the implementation produced,
 * plus the review that waits on them.
 *
 * The review is created here rather than at graph creation precisely so it can
 * depend on the execution. A review whose only dependency is the implementation
 * is claimable as soon as the model answers, and would pass judgement on work
 * that has not run.
 *
 * A fresh review node is appended per cycle rather than an existing one being
 * mutated, so `astra-review-1` keeps the verdict that triggered the repair.
 */
export async function expandWithExecutionPlan({
  graphId,
  plan,
  agent,
  cycle = 1,
  now = new Date()
}) {
  const profile = profileForAgent(agent);
  const normalized = profile.normalizePlan(plan);
  if (!normalized) throw new Error("The implementation did not produce a usable execution plan");

  const prefix = "exec" + cycle + ":";
  const executionNodes = graphFromExecutionPlan(normalized, { taskType: profile.taskType })
    .map(node => ({
      ...node,
      key: prefix + node.key,
      dependsOn: node.dependsOn.length === 0
        ? [cycle === 1 ? "fable-implement" : "fable-repair-" + (cycle - 1)]
        : node.dependsOn.map(dep => prefix + dep)
    }));

  const reviewKey = "astra-review-" + cycle;
  const terminal = executionNodes
    .filter(node => !executionNodes.some(other => other.dependsOn.includes(node.key)))
    .map(node => node.key);

  const review = modelNode(MODEL_NODE_KINDS.MODEL_REVIEW, {
    key: reviewKey,
    dependsOn: terminal
  });

  const result = await expandGraph({
    graphId,
    nodes: [...executionNodes, review],
    reason: "execution plan from implementation cycle " + cycle,
    now
  });

  return { ...result, reviewKey, executionKeys: executionNodes.map(n => n.key) };
}

/**
 * Append a repair branch, and only when the review actually asked for one.
 *
 * Nothing is reserved for a repair until this runs, so a task that passes first
 * time never holds budget for a cycle it did not need.
 */
export async function expandWithRepair({ graphId, reviewKey, cycle, now = new Date() }) {
  const repair = modelNode(MODEL_NODE_KINDS.MODEL_REPAIR, {
    key: "fable-repair-" + cycle,
    dependsOn: [reviewKey],
    complexity: 1
  });

  return expandGraph({
    graphId,
    nodes: [repair],
    reason: "review requested a revision (cycle " + cycle + ")",
    now
  });
}

/**
 * What the graph should do next, derived from its own nodes.
 *
 * Deliberately a pure reading of durable state rather than something the loop
 * remembers: a worker that restarts mid-cycle reaches the same conclusion the
 * one that died would have.
 */
export async function nextModelGraphAction({ taskId, tenantId }) {
  // Settled graphs are included deliberately. A review that asks for a repair
  // arrives after every node has succeeded, so the graph reads as finished at
  // exactly the moment its verdict has to be acted on; reading only active
  // graphs would make the repair cycle invisible.
  const view = await graphForTask({ taskId, tenantId, includeFinished: true });
  if (!view) return { action: "none" };

  const byKey = new Map(view.nodes.map(node => [node.key, node]));
  const succeeded = key => byKey.get(key)?.status === "succeeded";

  // How many implement/review cycles have already been appended.
  const cycles = view.nodes.filter(n => n.key.startsWith("astra-review-")).length;

  // The implementation has produced a plan, but no execution nodes exist yet.
  const implementKey = cycles === 0 ? "fable-implement" : "fable-repair-" + cycles;
  if (succeeded(implementKey) && !view.nodes.some(n => n.key.startsWith("exec" + (cycles + 1) + ":"))) {
    return {
      action: "expand-execution",
      cycle: cycles + 1,
      implementNode: byKey.get(implementKey),
      graphId: view.graph.id
    };
  }

  // A review has decided. Its verdict lives in the node's own stored output, so
  // this survives a restart without the loop having to remember it.
  for (let cycle = cycles; cycle >= 1; cycle -= 1) {
    const reviewKey = "astra-review-" + cycle;
    const review = byKey.get(reviewKey);
    if (!review || review.status !== "succeeded") continue;

    const decision = review.output?.structured?.review?.decision;
    if (decision === REVIEW_OUTCOMES.REVISE && !byKey.has("fable-repair-" + cycle)) {
      return { action: "expand-repair", cycle, reviewKey, graphId: view.graph.id };
    }
    if (decision === REVIEW_OUTCOMES.PASS) {
      return { action: "verify", cycle, graphId: view.graph.id };
    }
    if (decision === REVIEW_OUTCOMES.BLOCK) {
      return { action: "block", cycle, reason: review.output.structured.review.reason, graphId: view.graph.id };
    }
    break;
  }

  return { action: "none", graphId: view.graph.id };
}
