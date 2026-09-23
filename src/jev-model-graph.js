import { loadDb } from "./store.js";
import { getAgent } from "./agent-manager.js";
import { createTaskGraph, expandGraph, graphForTask } from "./jev.js";
import { DEPENDENCY_MODE } from "./jev-domain.js";
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
  // A review must see a FAILED execution, not be skipped by it. Under the
  // normal rule a failed build would skip its own review, and the task would
  // stop with nobody having decided what to do about the failure — which is
  // exactly how a build failure used to be sent back to Fable.
  review.dependsOnMode = DEPENDENCY_MODE.SETTLED;
  // Every verdict owes the graph another node: a repair, or the verification
  // that interprets the evidence. Until that node exists the graph is not
  // finished, even when every node in it has settled.
  review.payload.expandsGraph = true;

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
 * Append the verification node for a review that passed.
 *
 * MODEL_VERIFY is deliberately NOT the thing that decides whether the task is
 * done. The objective verifier has already run by the time this node exists,
 * and its record is carried in the node's payload as `evidence`. The model's
 * job here is interpretation — which requirement each check covers, what a
 * failure actually means — and its interpretation cannot promote a failing
 * verification to a passing one. Section: model interpretation is not evidence.
 */
export async function expandWithVerify({ graphId, reviewKey, cycle, evidence, now = new Date() }) {
  const verify = modelNode(MODEL_NODE_KINDS.MODEL_VERIFY, {
    key: "model-verify-" + cycle,
    dependsOn: [reviewKey]
  });

  // The evidence travels with the node, so a worker that claims it after a
  // restart interprets the same record rather than re-deriving one.
  verify.payload.evidence = evidence ?? null;

  return expandGraph({
    graphId,
    nodes: [verify],
    reason: "verification evidence ready for interpretation (cycle " + cycle + ")",
    now
  });
}

/**
 * How many repair cycles a task is allowed before it stops asking the models.
 *
 * A review that keeps returning REVISE is not a bug to be retried away: it is
 * either a task the models cannot complete or a review that disagrees with the
 * implementation on something neither will concede. Either way the money is
 * real and each cycle costs a plan, an implementation and a review, so the
 * cycle count is bounded and the task ends in NEEDS_REVIEW rather than looping.
 */
export function maxRepairCycles() {
  return Math.max(0, Math.trunc(readNumberEnv("RAZEKIT_MAX_REPAIR_CYCLES", 3)));
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
      // The limit is checked HERE rather than when the repair is appended,
      // because appending it is what spends the money. A task at the ceiling
      // stops with the findings intact for a person to read.
      if (cycle >= maxRepairCycles()) {
        return {
          action: "repair-limit",
          cycle,
          reviewKey,
          limit: maxRepairCycles(),
          findings: review.output?.structured?.review?.findings ?? [],
          reason: review.output?.structured?.review?.reason || "",
          graphId: view.graph.id
        };
      }
      return { action: "expand-repair", cycle, reviewKey, graphId: view.graph.id };
    }

    if (decision === REVIEW_OUTCOMES.PASS) {
      const verify = byKey.get("model-verify-" + cycle);
      // No verification node yet: the objective verifier has to run and its
      // record has to exist before a node can be created to interpret it.
      if (!verify) {
        return { action: "expand-verify", cycle, reviewKey, graphId: view.graph.id };
      }
      if (verify.status === "succeeded") {
        return {
          action: "verified",
          cycle,
          verifyNode: verify,
          evidence: verify.payload?.evidence ?? null,
          interpretation: verify.output?.structured?.review ?? null,
          graphId: view.graph.id
        };
      }
      // Created but not finished — the worker claims it on the next pass.
      return { action: "none", cycle, graphId: view.graph.id };
    }

    if (decision === REVIEW_OUTCOMES.BLOCK) {
      return {
        action: "block",
        cycle,
        reason: review.output.structured.review.blockedOn ||
          review.output.structured.review.reason ||
          "This task needs a decision from you before it can continue.",
        graphId: view.graph.id
      };
    }
    break;
  }

  return { action: "none", graphId: view.graph.id };
}
