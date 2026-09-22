import { APP_WEB_STEP_KINDS } from "./app-web-domain.js";
import { GAME_STEP_KINDS } from "./game-domain.js";
import { assertGraphShape } from "./jev-domain.js";

// Turning a planner's step list into an execution graph.
//
// The plans Fable produces are a flat ordered list, and their contract has
// always been "these run in order". A graph must therefore not be *weaker* than
// that list: any parallelism introduced here has to be parallelism the list
// never actually relied on, or this converter silently changes what a plan
// means and the first symptom is a build that works on one worker and not on
// another.
//
// So the derivation is deliberately conservative:
//
//   barrier steps   anything that observes the whole workspace — a command, a
//                   package, a deploy, a smoke test, an engine action — depends
//                   on EVERY step before it. This is exactly the sequential
//                   guarantee the list gave.
//
//   write steps     a file write or mkdir depends only on the most recent
//                   barrier, plus any earlier write touching the same path or a
//                   directory above it. Two writes to different paths never
//                   observed each other in the list model either, so running
//                   them together changes nothing except the wall clock.
//
// A step that declares its own `dependsOn` bypasses all of this. A model that
// has been taught the graph shape should be able to express it directly, and
// the derivation is the fallback for the plans that have not.

// Steps after which the workspace must be fully settled.
const APP_WEB_BARRIERS = new Set([
  APP_WEB_STEP_KINDS.COMMAND,
  APP_WEB_STEP_KINDS.SERVICE,
  APP_WEB_STEP_KINDS.BROWSER_SMOKE,
  APP_WEB_STEP_KINDS.DEPLOY,
  APP_WEB_STEP_KINDS.PACKAGE
]);

const GAME_BARRIERS = new Set([
  GAME_STEP_KINDS.PROJECT_INIT,
  GAME_STEP_KINDS.COMMAND,
  GAME_STEP_KINDS.ENGINE_ACTION,
  GAME_STEP_KINDS.PLAYTEST,
  GAME_STEP_KINDS.BUILD,
  GAME_STEP_KINDS.PACKAGE
]);

const WRITE_KINDS = new Set([
  APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE,
  APP_WEB_STEP_KINDS.WORKSPACE_MKDIR,
  GAME_STEP_KINDS.ASSET_WRITE,
  GAME_STEP_KINDS.ASSET_COPY
]);

/**
 * The tool scopes a step of this kind legitimately needs.
 *
 * This is the narrowing that section 7 asks for, and it is derived from the
 * step rather than taken from the model: a plan cannot ask for a wider scope
 * than its own step kind implies by writing one into the JSON. The agent's own
 * granted permissions remain the outer boundary — this only ever subtracts.
 */
export function scopesForStep(step) {
  switch (step.kind) {
    case APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE:
    case APP_WEB_STEP_KINDS.WORKSPACE_MKDIR:
    case GAME_STEP_KINDS.ASSET_WRITE:
      return ["filesystem:workspace:write"];

    case GAME_STEP_KINDS.ASSET_COPY:
      return ["filesystem:workspace:read", "filesystem:workspace:write"];

    case APP_WEB_STEP_KINDS.COMMAND:
    case GAME_STEP_KINDS.COMMAND: {
      // `git init` is a git operation, not an arbitrary process. Naming it that
      // way means a node that only needs git never carries shell execution.
      if (step.executable === "git") return ["git:git:read", "git:git:write"];
      return ["shell:process:execute", "filesystem:workspace:read"];
    }

    case APP_WEB_STEP_KINDS.SERVICE:
      return ["database:database:read", "database:database:write"];

    case APP_WEB_STEP_KINDS.BROWSER_SMOKE:
      return ["browser:browser:navigate", "browser:browser:inspect", "browser:browser:test"];

    case APP_WEB_STEP_KINDS.DEPLOY:
      return ["deploy-web:deployment:deploy"];

    case GAME_STEP_KINDS.PROJECT_INIT:
    case GAME_STEP_KINDS.ENGINE_ACTION:
      return ["engine:engine:read", "engine:engine:write"];

    case GAME_STEP_KINDS.PLAYTEST:
      return ["game-playtest:playtest:run", "game-playtest:playtest:inspect"];

    case GAME_STEP_KINDS.BUILD:
      return ["game-build:build:build"];

    case APP_WEB_STEP_KINDS.PACKAGE:
    case GAME_STEP_KINDS.PACKAGE:
      return ["shell:process:execute", "filesystem:workspace:write"];

    default:
      return [];
  }
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when `earlier` is the same path as `later`, or a directory containing it. */
function pathsInterfere(earlier, later) {
  if (!earlier || !later) return false;
  if (earlier === later) return true;
  return later.startsWith(earlier + "/") || earlier.startsWith(later + "/");
}

function pathOfStep(step) {
  if (step.kind === GAME_STEP_KINDS.ASSET_COPY) return normalizePath(step.destination);
  return normalizePath(step.path);
}

/**
 * Convert a flat execution plan into JEV graph nodes.
 *
 * Returns nodes ready for createTaskGraph — validated, so a plan that cannot
 * become a runnable graph is rejected here rather than at insert time.
 */
export function graphFromExecutionPlan(plan, { taskType = "app" } = {}) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("An execution plan with at least one step is required");
  }

  const barriers = taskType === "game" ? GAME_BARRIERS : APP_WEB_BARRIERS;
  const nodes = [];
  const seenKeys = new Set();

  // The most recent barrier, and every write since it. A write only needs to be
  // ordered against writes that came after the last barrier: anything before
  // that barrier is already transitively ordered through it.
  let lastBarrierKey = null;
  let writesSinceBarrier = [];
  let allKeysSoFar = [];

  for (const [index, step] of plan.steps.entries()) {
    const key = String(step.id || "step-" + (index + 1));
    if (seenKeys.has(key)) {
      throw new Error("Execution plan contains a duplicate step id: " + key);
    }
    seenKeys.add(key);

    const isBarrier = barriers.has(step.kind);
    const declared = Array.isArray(step.dependsOn) ? step.dependsOn.filter(Boolean) : null;

    let dependsOn;
    if (declared) {
      dependsOn = [...new Set(declared)];
    } else if (isBarrier) {
      // Every prior step. The list model's promise, kept exactly.
      dependsOn = [...allKeysSoFar];
    } else if (WRITE_KINDS.has(step.kind)) {
      const here = pathOfStep(step);
      const conflicting = writesSinceBarrier
        .filter(prior => pathsInterfere(prior.path, here))
        .map(prior => prior.key);
      dependsOn = [...new Set([...(lastBarrierKey ? [lastBarrierKey] : []), ...conflicting])];
    } else {
      // An unrecognised kind is treated as a barrier. Guessing that something
      // unknown is safe to parallelise is the wrong default.
      dependsOn = [...allKeysSoFar];
    }

    nodes.push({
      key,
      kind: step.kind,
      description: step.description || step.phase || step.kind,
      dependsOn,
      payload: step,
      resourceClass: step.resourceClass || "cpu",
      // The flat engine expressed retries as "extra attempts after the first";
      // JEV counts total attempts. Converting here keeps a plan's meaning the
      // same rather than quietly giving every step one more try than it asked.
      maxAttempts: Math.max(1, Number(step.retries ?? 0) + 1),
      timeoutMs: Math.max(0, Number(step.timeoutMs ?? 0)),
      budgetMinor: Math.max(0, Number(step.budgetMinor ?? 0)),
      toolScopes: Array.isArray(step.toolScopes) && step.toolScopes.length > 0
        ? [...step.toolScopes]
        : scopesForStep(step)
    });

    allKeysSoFar.push(key);
    if (isBarrier) {
      lastBarrierKey = key;
      writesSinceBarrier = [];
    } else if (WRITE_KINDS.has(step.kind)) {
      writesSinceBarrier.push({ key, path: pathOfStep(step) });
    }
  }

  // A model-declared dependsOn can name a step that does not exist or close a
  // cycle. Validate before any of this is stored.
  assertGraphShape(nodes);
  return nodes;
}

/**
 * Spread a task's total budget across the nodes that will actually spend it.
 *
 * Only barrier-style work costs anything real — writing a file to a local
 * workspace does not consume model or worker time in any measurable way — so
 * the budget is divided between the steps that run something. Dividing it
 * across every node instead would reserve budget against file writes and leave
 * too little for the build that matters.
 *
 * Minor units throughout: the remainder from the division is given to the last
 * node rather than dropped, so the parts always sum to the whole.
 */
export function distributeBudgetMinor(nodes, totalMinor, { taskType = "app" } = {}) {
  const total = Math.max(0, Math.trunc(Number(totalMinor) || 0));
  if (total === 0) return nodes;

  const barriers = taskType === "game" ? GAME_BARRIERS : APP_WEB_BARRIERS;
  const spending = nodes.filter(node => barriers.has(node.kind));
  const targets = spending.length > 0 ? spending : nodes;

  const share = Math.floor(total / targets.length);
  let assigned = 0;
  targets.forEach((node, index) => {
    const isLast = index === targets.length - 1;
    node.budgetMinor = isLast ? total - assigned : share;
    assigned += share;
  });

  return nodes;
}
