import { createHash } from "node:crypto";
import { loadDb, transact, id } from "./store.js";
import { agentTypeForTask } from "./domain.js";
import { getTool, listTools, requiredScopesForTools } from "./tool-registry.js";

// What happens before a task is allowed to start.
//
// Until now a task arrived already authorized: POST /api/tasks took one boolean
// — acceptAutonomousExecution — and from it granted every scope the preflight
// had guessed at. The user agreed to a sentence; the system read it as consent
// to a tool list they were never shown.
//
// This file separates the two halves that were collapsed:
//
//   PREDICTION      what this task will probably need. Costs nothing, creates
//                   nothing, grants nothing. It can be wrong, and being wrong
//                   must be survivable.
//
//   AUTHORIZATION   what the user actually agreed to, derived only from a
//                   prediction they were shown and confirmed by its fingerprint.
//
// The rule the whole file exists to enforce: a prediction is not an
// authorization. Nothing here returns an authorization without a confirmation
// that matches the preview it came from, and no level of autonomy pre-approves
// the operations that can lose someone's data or money.

// ── Execution levels ────────────────────────────────────────────────────────
//
// A level is an ENVELOPE — how much the task may do before it has to stop and
// ask — not a quality setting. HIGH is not "better"; it is a task that
// interrupts you less and can therefore get further in a direction you did not
// intend before you see it. Choosing LOW for something delicate is the right
// answer, not a cautious one.

export const EXECUTION_LEVELS = {
  LOW: "low",
  MID: "mid",
  HIGH: "high",
  CUSTOM: "custom"
};

// Scopes NO level pre-authorizes, whatever the user picks.
//
// Not a policy about risk appetite: these are the operations whose blast radius
// is outside the workspace. A deployment reaches real users; a database write
// reaches real records. Both stay runtime approvals so that the decision is
// made against the actual change rather than against a guess made before the
// task started.
export const NEVER_PREAUTHORIZED_SCOPES = Object.freeze([
  "deployment:deploy",
  "database:write"
]);

const WORKSPACE_SCOPES = ["workspace:read", "workspace:write"];
const BUILD_SCOPES = ["process:execute", "git:read", "git:write", "assets:read", "assets:write"];
const GAME_SCOPES = ["engine:read", "engine:write", "engine:build", "playtest:run", "playtest:inspect", "game-build:build", "game-build:package"];
const INSPECTION_SCOPES = ["browser:navigate", "browser:inspect", "browser:test", "database:read"];

const LEVEL_DEFINITIONS = {
  [EXECUTION_LEVELS.LOW]: {
    key: EXECUTION_LEVELS.LOW,
    label: "Supervised",
    autonomy: "supervised",
    summary: "Reads and writes inside its own workspace. Asks before running anything.",
    preauthorizedScopes: [...WORKSPACE_SCOPES],
    maxConcurrentNodes: 1,
    maxRepairCycles: 1,
    budgetMultiplier: 1,
    deploymentScope: "none"
  },
  [EXECUTION_LEVELS.MID]: {
    key: EXECUTION_LEVELS.MID,
    label: "Standard",
    autonomy: "standard",
    summary: "Builds and tests on its own. Asks before anything leaves the workspace.",
    preauthorizedScopes: [...WORKSPACE_SCOPES, ...BUILD_SCOPES, ...GAME_SCOPES],
    maxConcurrentNodes: 2,
    maxRepairCycles: 2,
    budgetMultiplier: 1.5,
    deploymentScope: "preview"
  },
  [EXECUTION_LEVELS.HIGH]: {
    key: EXECUTION_LEVELS.HIGH,
    label: "Extended",
    autonomy: "extended",
    summary: "Builds, tests, inspects and reads external data without stopping. Still asks before it changes anything outside the workspace.",
    preauthorizedScopes: [...WORKSPACE_SCOPES, ...BUILD_SCOPES, ...GAME_SCOPES, ...INSPECTION_SCOPES],
    maxConcurrentNodes: 4,
    maxRepairCycles: 3,
    budgetMultiplier: 2.5,
    deploymentScope: "staging"
  }
};

export function executionLevels() {
  return Object.values(LEVEL_DEFINITIONS).map(level => ({
    ...level,
    preauthorizedScopes: [...level.preauthorizedScopes],
    // Stated on every level, so the list a user reads never implies that
    // picking the highest one removes the interruptions.
    alwaysAsks: [...NEVER_PREAUTHORIZED_SCOPES]
  }));
}

export function levelDefinition(level) {
  const definition = LEVEL_DEFINITIONS[level];
  if (!definition) throw new Error("Unknown execution level: " + level);
  return {
    ...definition,
    preauthorizedScopes: [...definition.preauthorizedScopes],
    alwaysAsks: [...NEVER_PREAUTHORIZED_SCOPES]
  };
}

// ── Custom policy ───────────────────────────────────────────────────────────

/**
 * Check a custom policy before it is allowed to become an envelope.
 *
 * Returns `{ valid, errors, policy }` rather than throwing: a policy the user
 * typed is input, and input that is wrong deserves an explanation rather than a
 * stack trace. An invalid policy never becomes a partial one — there is no
 * "mostly accepted" custom level, because the part silently dropped would be
 * the part the user cared about.
 */
export function validateCustomPolicy(raw = {}) {
  const errors = [];
  const knownScopes = new Set(listTools().flatMap(tool => tool.scopes));

  const requestedTools = Array.isArray(raw.tools) ? raw.tools : [];
  for (const tool of requestedTools) {
    try {
      getTool(tool);
    } catch {
      errors.push("Unknown tool: " + tool);
    }
  }

  const requestedScopes = Array.isArray(raw.preauthorizedScopes) ? raw.preauthorizedScopes : [];
  for (const scope of requestedScopes) {
    if (!knownScopes.has(scope)) errors.push("Unknown scope: " + scope);
    if (NEVER_PREAUTHORIZED_SCOPES.includes(scope)) {
      errors.push(
        "'" + scope + "' cannot be pre-authorized at any level; it is approved at the moment it is used."
      );
    }
  }

  // A scope the task's tools cannot produce is not a smaller grant, it is a
  // meaningless one — and it would sit in the authorization record looking like
  // something was permitted.
  if (requestedTools.length > 0) {
    const reachable = new Set(requiredScopesForTools(requestedTools.filter(tool => {
      try { getTool(tool); return true; } catch { return false; }
    })));
    for (const scope of requestedScopes) {
      if (knownScopes.has(scope) && !reachable.has(scope)) {
        errors.push("Scope '" + scope + "' is not used by any of the selected tools.");
      }
    }
  }

  const maxConcurrentNodes = Number(raw.maxConcurrentNodes ?? 2);
  if (!Number.isFinite(maxConcurrentNodes) || maxConcurrentNodes < 1 || maxConcurrentNodes > 8) {
    errors.push("maxConcurrentNodes must be between 1 and 8.");
  }

  const maxRepairCycles = Number(raw.maxRepairCycles ?? 2);
  if (!Number.isFinite(maxRepairCycles) || maxRepairCycles < 0 || maxRepairCycles > 10) {
    errors.push("maxRepairCycles must be between 0 and 10.");
  }

  if (raw.deadline && Number.isNaN(Date.parse(raw.deadline))) {
    errors.push("deadline must be a date.");
  }

  if (errors.length > 0) return { valid: false, errors, policy: null };

  return {
    valid: true,
    errors: [],
    policy: {
      key: EXECUTION_LEVELS.CUSTOM,
      label: "Custom",
      autonomy: "custom",
      summary: "Exactly the tools and limits you chose.",
      preauthorizedScopes: [...new Set(requestedScopes)].sort(),
      tools: [...new Set(requestedTools)].sort(),
      maxConcurrentNodes,
      maxRepairCycles,
      budgetMultiplier: 1,
      deploymentScope: raw.deploymentScope || "none",
      deadline: raw.deadline || null,
      alwaysAsks: [...NEVER_PREAUTHORIZED_SCOPES]
    }
  };
}

// ── Prediction ──────────────────────────────────────────────────────────────

const SIGNALS = [
  { test: /database|postgres|mysql|neon|schema|migration/, need: "database", service: "database", risk: "Reads or writes data that outlives the task." },
  { test: /auth|login|signup|session|password/, need: "database", service: "identity", risk: "Handles credentials belonging to real people." },
  { test: /payment|checkout|invoice|billing|refund|payout/, need: null, service: "payment provider", risk: "Moves money. Every such step stops for approval." },
  { test: /email|otp|sms|notification/, need: null, service: "messaging provider", risk: "Sends messages to real recipients." },
  { test: /deploy|hosting|production|release|publish/, need: "deploy-web", service: "hosting", risk: "Reaches real users. Never pre-authorized." },
  { test: /scrape|crawl|browse|screenshot/, need: "browser", service: null, risk: "Fetches third-party content, which is data and never instruction." }
];

const BASE_TOOLS = {
  website: ["filesystem", "shell", "git", "node"],
  app: ["filesystem", "shell", "git", "node"],
  game: ["filesystem", "shell", "git", "engine", "assets", "game-playtest", "game-build"]
};

/**
 * What this task will probably need.
 *
 * A guess, and labelled one. It is built from the request's own words rather
 * than from a model call, because this runs before the user has agreed to spend
 * anything — asking a paid model what a task might cost is a charge for an
 * estimate.
 */
export function predictTaskRequirements(draft) {
  const text = [draft.title, draft.originalRequest, draft.specification]
    .filter(Boolean).join(" ").toLowerCase();

  const complexity = text.length > 4000 ? "high" : text.length > 1600 ? "medium" : "low";

  const tools = new Set(BASE_TOOLS[draft.taskType] ?? BASE_TOOLS.website);
  const externalServices = [];
  const risks = [];

  for (const signal of SIGNALS) {
    if (!signal.test.test(text)) continue;
    if (signal.need) tools.add(signal.need);
    if (signal.service) externalServices.push(signal.service);
    risks.push(signal.risk);
  }
  if (draft.taskType === "game") externalServices.push("game engine/build toolchain");

  const toolList = [...tools].sort();
  const toolScopes = requiredScopesForTools(toolList);

  return {
    isPrediction: true,
    complexity,
    agentType: agentTypeForTask(draft.taskType),
    tools: toolList,
    toolScopes,
    externalServices: [...new Set(externalServices)],
    risks: [...new Set(risks)],
    // Named separately from `risks` because this is the operational consequence
    // the user will actually experience: these are the moments a task stops.
    willAskFor: toolScopes.filter(scope => NEVER_PREAUTHORIZED_SCOPES.includes(scope)),
    resources: {
      // Deliberately coarse. A precise-looking number derived from the length of
      // a sentence would be a confident guess, which is worse than an honest one.
      estimatedNodes: complexity === "high" ? 24 : complexity === "medium" ? 12 : 6,
      workspace: "isolated",
      resourceClass: draft.taskType === "game" ? "gpu-optional" : "cpu"
    }
  };
}

const BASE_BUDGET = {
  website: { low: 8, medium: 25, high: 60 },
  app: { low: 10, medium: 30, high: 75 },
  game: { low: 25, medium: 75, high: 180 }
};

/**
 * What this task will probably cost, as a range.
 *
 * A range and a confidence, never a single number presented as a price. The
 * authoritative figure is what the ledger settles; this is what the user is
 * agreeing to risk, which is a different thing and should look like one.
 */
export function estimateTaskBudget(draft, { level = EXECUTION_LEVELS.MID, policy = null } = {}) {
  const prediction = predictTaskRequirements(draft);
  const table = BASE_BUDGET[draft.taskType] ?? BASE_BUDGET.website;
  const base = table[prediction.complexity];
  const multiplier = policy?.budgetMultiplier ?? levelDefinition(level).budgetMultiplier;

  const expected = Math.round(base * multiplier);
  return {
    minimum: Math.round(expected * 0.4),
    expected,
    // The ceiling carries the repair allowance: a task that needs a second pass
    // must not discover half way through that it could never have afforded one.
    maximum: Math.round(expected * 2),
    currency: "USD",
    // Low on purpose. Without provider pricing configured and without history
    // this is an informed guess, and reporting it as certain turns an estimate
    // into a promise nobody can keep.
    confidence: 0.4,
    basis: "task type and request complexity, scaled by the execution level"
  };
}

// ── Preview ─────────────────────────────────────────────────────────────────

/**
 * Everything the user should see before agreeing to anything.
 *
 * `fingerprint` is what makes the confirmation meaningful: it covers the fields
 * that decide what the task may do, so a confirmation can only authorize the
 * preview it was shown. Changing the tools after the user agreed produces a
 * different fingerprint and is refused rather than silently honoured.
 */
export async function createTaskPreview(draft, {
  level = EXECUTION_LEVELS.MID,
  custom = null,
  tenantId = null,
  userId = null,
  now = new Date()
} = {}) {
  let policy;
  if (level === EXECUTION_LEVELS.CUSTOM) {
    const validation = validateCustomPolicy(custom ?? {});
    if (!validation.valid) {
      return { ok: false, errors: validation.errors };
    }
    policy = validation.policy;
  } else {
    policy = levelDefinition(level);
  }

  const prediction = predictTaskRequirements(draft);
  const budget = estimateTaskBudget(draft, { level, policy });

  // The tools a custom policy names win over the prediction — the user chose.
  const tools = policy.tools?.length ? policy.tools : prediction.tools;
  const reachableScopes = new Set(requiredScopesForTools(tools));

  // What the level pre-authorizes, narrowed to what this task can actually use,
  // and with the never-pre-authorized scopes removed whatever anyone asked for.
  const preauthorizedScopes = policy.preauthorizedScopes
    .filter(scope => reachableScopes.has(scope))
    .filter(scope => !NEVER_PREAUTHORIZED_SCOPES.includes(scope))
    .sort();

  const willAskFor = [...reachableScopes]
    .filter(scope => !preauthorizedScopes.includes(scope))
    .sort();

  const preview = {
    id: id("preview"),
    tenantId,
    userId,
    draft: {
      taskType: draft.taskType,
      title: draft.title ?? null,
      originalRequest: draft.originalRequest,
      specification: draft.specification ?? draft.originalRequest
    },
    level: policy.key,
    policy: {
      label: policy.label,
      autonomy: policy.autonomy,
      summary: policy.summary,
      maxConcurrentNodes: policy.maxConcurrentNodes,
      maxRepairCycles: policy.maxRepairCycles,
      deploymentScope: policy.deploymentScope
    },
    prediction,
    budget,
    authorizationPreview: {
      // Said plainly, because the distinction is the entire point of the screen.
      grantsNothing: true,
      tools,
      preauthorizedScopes,
      willAskFor,
      neverPreauthorized: [...NEVER_PREAUTHORIZED_SCOPES]
    },
    createdAt: now.toISOString(),
    confirmedAt: null,
    taskId: null
  };

  preview.fingerprint = fingerprintOf(preview);

  await transact(db => db.taskPreviews.push(preview));
  return { ok: true, preview };
}

/**
 * The fields a confirmation is a confirmation OF.
 *
 * Deliberately not the whole object: the id and the timestamps change nothing
 * about what the task may do, and including them would make the fingerprint
 * unstable for no gain. Everything that decides capability is in here.
 */
function fingerprintOf(preview) {
  const decisive = {
    draft: preview.draft,
    level: preview.level,
    policy: preview.policy,
    tools: preview.authorizationPreview.tools,
    preauthorizedScopes: preview.authorizationPreview.preauthorizedScopes,
    budget: { expected: preview.budget.expected, maximum: preview.budget.maximum, currency: preview.budget.currency }
  };
  return createHash("sha256").update(JSON.stringify(decisive)).digest("hex").slice(0, 32);
}

export async function getTaskPreview(previewId, { tenantId = null } = {}) {
  const db = await loadDb();
  const preview = db.taskPreviews.find(item => item.id === previewId);
  if (!preview) return null;
  // Tenant scoping is checked here rather than by the caller, because a preview
  // carries the shape of someone's task.
  if (tenantId && preview.tenantId && preview.tenantId !== tenantId) return null;
  return preview;
}

/**
 * Narrow a set of requested scopes to what may actually be pre-authorized.
 *
 * Used by every path that grants scopes, not only the preview one. A second
 * route into the authorization record that did not apply this rule would make
 * the rule advisory — and the route that skipped it would be the one an
 * attacker, or a well-meaning integration, reached for.
 *
 * Returns what was granted AND what was refused, because silently dropping a
 * scope someone asked for leaves them believing the task can do something it
 * cannot.
 */
export function narrowPreauthorizedScopes(requestedScopes = [], tools = []) {
  const reachable = new Set(requiredScopesForTools(
    tools.filter(tool => { try { getTool(tool); return true; } catch { return false; } })
  ));

  const granted = [];
  const refused = [];

  for (const scope of new Set(requestedScopes)) {
    if (NEVER_PREAUTHORIZED_SCOPES.includes(scope)) {
      refused.push({ scope, reason: "approved at the moment it is used, never in advance" });
    } else if (tools.length > 0 && !reachable.has(scope)) {
      refused.push({ scope, reason: "no selected tool uses it" });
    } else {
      granted.push(scope);
    }
  }

  return { granted: granted.sort(), refused };
}

// ── Confirmation ────────────────────────────────────────────────────────────

/**
 * Turn a confirmed preview into an authorization.
 *
 * The only function in this file that produces one, and it refuses unless:
 *
 *   - the preview exists and belongs to this tenant,
 *   - the fingerprint matches what the user was shown,
 *   - autonomous execution is accepted explicitly,
 *   - a budget ceiling is given explicitly.
 *
 * A missing confirmation is not a weaker confirmation. There is no default
 * here, because a default would be the system deciding on the user's behalf
 * what they were willing to risk.
 */
export async function authorizeFromPreview({
  previewId,
  fingerprint,
  acceptAutonomousExecution,
  maxBudget,
  tenantId = null,
  userId = null,
  now = new Date()
}) {
  const preview = await getTaskPreview(previewId, { tenantId });
  if (!preview) return { ok: false, errors: ["That task preview no longer exists. Review the task again."] };

  const errors = [];
  if (preview.confirmedAt) errors.push("This preview has already been used to start a task.");
  if (fingerprint !== preview.fingerprint) {
    errors.push("The task changed after it was shown to you. Review it again before starting.");
  }
  if (acceptAutonomousExecution !== true) {
    errors.push("Autonomous execution has to be accepted explicitly.");
  }

  const ceiling = Number(maxBudget);
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    errors.push("A budget ceiling greater than zero is required.");
  }

  if (errors.length > 0) return { ok: false, errors, preview };

  const warnings = [];
  if (ceiling < preview.budget.expected) {
    // Allowed — it is the user's money and their ceiling. Said out loud,
    // because a task that stops half-built for want of budget should not be a
    // surprise.
    warnings.push(
      "This ceiling is below the expected cost of " + preview.budget.expected + " " +
      preview.budget.currency + ". The task may stop part-way and ask for more."
    );
  }

  return {
    ok: true,
    warnings,
    preview,
    authorization: {
      autonomousExecution: true,
      level: preview.level,
      // Exactly what the preview showed. Not recomputed here: recomputing would
      // let a change between preview and confirmation through, which is the
      // thing the fingerprint exists to catch.
      scopes: [
        "autonomous task execution",
        ...preview.authorizationPreview.preauthorizedScopes
      ],
      toolScopes: [...preview.authorizationPreview.preauthorizedScopes],
      tools: [...preview.authorizationPreview.tools],
      neverPreauthorized: [...NEVER_PREAUTHORIZED_SCOPES],
      previewId: preview.id,
      previewFingerprint: preview.fingerprint,
      authorizedBy: userId,
      authorizedAt: now.toISOString()
    },
    limits: {
      maxBudget: ceiling,
      maxConcurrentNodes: preview.policy.maxConcurrentNodes,
      maxRepairCycles: preview.policy.maxRepairCycles,
      deploymentScope: preview.policy.deploymentScope
    }
  };
}

/** Mark a preview as spent, so one agreement cannot start two tasks. */
export async function markPreviewConfirmed(previewId, taskId, { now = new Date() } = {}) {
  return transact(db => {
    const preview = db.taskPreviews.find(item => item.id === previewId);
    if (!preview) return null;
    if (preview.confirmedAt) return preview;
    preview.confirmedAt = now.toISOString();
    preview.taskId = taskId;
    return preview;
  });
}
