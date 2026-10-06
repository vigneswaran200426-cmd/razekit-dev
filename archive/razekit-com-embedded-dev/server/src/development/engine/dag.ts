// Execution steps as a dependency graph.
//
// A plan's steps are not a list to run top to bottom: "package" means nothing
// if "build" failed, and "build" should not run on code whose tests did not
// pass. Each step names what it depends on, and a step runs only once all of
// those passed. A failure skips its dependants and nothing else, so one broken
// test file does not hide whether an unrelated step would have worked.
//
// The graph is validated before anything runs: unique ids, known
// dependencies, no cycles, bounded size. A cycle in a model-written plan is a
// plan that can never finish, and it is refused up front rather than
// discovered by a runner that hangs.
import { DevError, ERR } from './errors.js';
import type { ExecutionStep, StepResult } from './types.js';

export const MAX_STEPS = 40;
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function invalid(message: string) {
  return new DevError(ERR.PLAN_INVALID, message);
}

/** Validates the graph and returns a deterministic topological order. */
export function planOrder(steps: ExecutionStep[]): string[] {
  if (!Array.isArray(steps) || steps.length === 0) throw invalid('A plan needs at least one step.');
  if (steps.length > MAX_STEPS) throw invalid(`A plan may have at most ${MAX_STEPS} steps.`);

  const byId = new Map<string, ExecutionStep>();
  for (const step of steps) {
    if (!STEP_ID.test(String(step?.id))) throw invalid(`Step id ${JSON.stringify(step?.id)} is not valid.`);
    if (byId.has(step.id)) throw invalid(`Step id ${step.id} is used twice.`);
    byId.set(step.id, step);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!byId.has(dep)) throw invalid(`Step ${step.id} depends on ${dep}, which does not exist.`);
      if (dep === step.id) throw invalid(`Step ${step.id} depends on itself.`);
    }
  }

  // Kahn's algorithm, taking ready steps in plan order so the result is stable
  // for the same plan — a re-run executes in the same order it did before.
  const indegree = new Map(steps.map((s) => [s.id, (s.dependsOn ?? []).length]));
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < steps.length) {
    const next = steps.find((s) => !done.has(s.id) && indegree.get(s.id) === 0);
    if (!next) {
      const stuck = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
      throw invalid(`The plan has a dependency cycle among: ${stuck.join(', ')}.`);
    }
    order.push(next.id);
    done.add(next.id);
    for (const s of steps) {
      if ((s.dependsOn ?? []).includes(next.id)) indegree.set(s.id, (indegree.get(s.id) ?? 0) - 1);
    }
  }
  return order;
}

/**
 * Whether a step should run, given the results so far.
 *
 * `run` when every dependency passed; `skip` when any dependency did not pass
 * (failed or was itself skipped). Dependencies always precede a step in the
 * order, so there is no "not yet" case.
 */
export function stepDisposition(step: ExecutionStep, results: Map<string, StepResult>): 'run' | 'skip' {
  for (const dep of step.dependsOn ?? []) {
    if (results.get(dep)?.status !== 'passed') return 'skip';
  }
  return 'run';
}

/** Step counts for the progress bar. */
export function stepSummary(results: StepResult[] | undefined | null) {
  const list = results ?? [];
  return {
    total: list.length,
    passed: list.filter((r) => r.status === 'passed').length,
    failed: list.filter((r) => r.status === 'failed').length,
    skipped: list.filter((r) => r.status === 'skipped').length,
  };
}
