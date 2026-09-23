import { graphForTask } from "./jev.js";
import { minorToMajor } from "./jev-budget.js";
import { isModelNodeKind } from "./jev-model-domain.js";

// The graph, as something a person can look at.
//
// Deliberately a projection rather than the rows. A node's payload is whatever
// its executor needs — file contents, command arguments, a model prompt — and
// it is the single most likely place in the whole record for something to
// appear that should not be shown: a token pasted into a config file, a
// connection string in a command. So the payload never leaves this function,
// and nor does a raw error object.
//
// What is left is what someone actually needs to answer "what is it doing, what
// has it done, and what is it waiting on": the real nodes, their real statuses,
// their real dependencies, how many attempts each has taken and what each one
// has cost. No synthesised nodes, no placeholder edges — a diagram that does
// not correspond to the graph is worse than no diagram, because it is believed.

const PHASE_BY_KIND = {
  model_plan: "Planning",
  model_analysis: "Analysis",
  model_replan: "Replanning",
  model_implement: "Implementation",
  model_repair: "Repair",
  model_review: "Review",
  model_verify: "Verification"
};

function phaseFor(node) {
  if (PHASE_BY_KIND[node.kind]) return PHASE_BY_KIND[node.kind];
  const cycle = /^exec(\d+):/.exec(node.key || "");
  return cycle ? "Build (pass " + cycle[1] + ")" : "Build";
}

/**
 * What this node cost, in whole currency units.
 *
 * `reserved` and `actual` are reported separately and both are reported even
 * when they differ wildly, because the difference is the interesting part: a
 * node that reserved $7.20 and spent $0.08 is the budget working as intended,
 * and hiding the reservation would make the ledger look arbitrary.
 */
function costOf(node) {
  const actualMinor = node.output?.costMinor;
  return {
    reserved: minorToMajor(node.budgetMinor || 0),
    actual: actualMinor === undefined || actualMinor === null ? null : minorToMajor(actualMinor)
  };
}

export async function taskGraphView({ taskId, tenantId }) {
  const view = await graphForTask({ taskId, tenantId, includeFinished: true });
  if (!view) return null;

  const nodes = view.nodes
    .slice()
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map(node => ({
      key: node.key,
      kind: node.kind,
      phase: phaseFor(node),
      isModelPhase: isModelNodeKind(node.kind),
      status: node.status,
      dependsOn: [...(node.dependsOn ?? [])],
      // Surfaced because "why did this never run" is a question people ask of a
      // graph, and SKIPPED alone does not answer it.
      skippedBecause: node.skippedBecause ?? null,
      attempt: Number(node.attempt || 0),
      maxAttempts: Number(node.maxAttempts || 1),
      // Who is holding it right now. Useful precisely when a task looks stuck.
      runningOn: node.status === "running" ? node.leaseOwner ?? null : null,
      leaseExpiresAt: node.status === "running" ? node.leaseExpiresAt ?? null : null,
      cost: costOf(node),
      // The message only. Never the error object, which carries whatever the
      // failing adapter happened to attach to it.
      error: node.error?.message ?? null,
      startedAt: node.startedAt ?? null,
      finishedAt: node.finishedAt ?? null,
      // The decision, for a node that made one. This is what makes a graph
      // readable as a story rather than a list of boxes.
      decision: node.output?.structured?.review?.decision ?? null
    }));

  const counts = nodes.reduce((totals, node) => {
    totals[node.status] = (totals[node.status] || 0) + 1;
    return totals;
  }, {});

  return {
    graphId: view.graph.id,
    status: view.graph.status,
    createdAt: view.graph.createdAt,
    finishedAt: view.graph.finishedAt ?? null,
    counts,
    totals: {
      nodes: nodes.length,
      reserved: Number(nodes.reduce((sum, node) => sum + node.cost.reserved, 0).toFixed(2)),
      actual: Number(nodes.reduce((sum, node) => sum + (node.cost.actual ?? 0), 0).toFixed(2))
    },
    nodes
  };
}
