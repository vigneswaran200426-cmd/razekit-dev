export const GAME_ENGINES = {
  UNITY: "unity",
  UNREAL: "unreal",
  GODOT: "godot"
};

export const GAME_STEP_KINDS = {
  PROJECT_INIT: "project_init",
  ASSET_WRITE: "asset_write",
  ASSET_COPY: "asset_copy",
  COMMAND: "command",
  ENGINE_ACTION: "engine_action",
  PLAYTEST: "playtest",
  BUILD: "build",
  PACKAGE: "package"
};

export function assertGameStep(step) {
  if (!step?.id) throw new Error("Game step id is required");
  if (!Object.values(GAME_STEP_KINDS).includes(step.kind)) {
    throw new Error("Unsupported game step kind: " + step.kind);
  }

  if ([GAME_STEP_KINDS.COMMAND, GAME_STEP_KINDS.ENGINE_ACTION].includes(step.kind)) {
    if (!step.action?.trim() && step.kind === GAME_STEP_KINDS.ENGINE_ACTION) {
      throw new Error("Engine action is required");
    }
    if (step.kind === GAME_STEP_KINDS.COMMAND && !Array.isArray(step.args)) {
      throw new Error("Game command args must be an array");
    }
  }

  if (step.kind === GAME_STEP_KINDS.PROJECT_INIT && !Object.values(GAME_ENGINES).includes(step.engine)) {
    throw new Error("Unsupported game engine: " + step.engine);
  }

  if (step.kind === GAME_STEP_KINDS.ASSET_WRITE) {
    if (!step.path?.trim()) throw new Error("Asset path is required");
    if (typeof step.content !== "string" && !Buffer.isBuffer(step.content)) {
      throw new Error("Asset write content must be string or Buffer");
    }
  }

  if (step.kind === GAME_STEP_KINDS.ASSET_COPY) {
    if (!step.source?.trim() || !step.destination?.trim()) {
      throw new Error("Asset copy source and destination are required");
    }
  }

  return step;
}

export function assertGamePlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Game execution plan is required");
  if (!plan.id) throw new Error("Game execution plan id is required");
  if (!plan.engine || !Object.values(GAME_ENGINES).includes(plan.engine)) {
    throw new Error("Game execution plan engine is invalid");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("Game execution plan must contain at least one step");
  }
  for (const step of plan.steps) assertGameStep(step);
  return plan;
}

export function normalizeGamePlan(rawPlan) {
  if (typeof rawPlan === "string") {
    try {
      rawPlan = JSON.parse(rawPlan);
    } catch {
      return null;
    }
  }
  if (!rawPlan || typeof rawPlan !== "object") return null;
  const plan = {
    ...rawPlan,
    id: rawPlan.id || "model-generated-game-plan",
    version: Number(rawPlan.version || 1),
    engine: rawPlan.engine,
    steps: Array.isArray(rawPlan.steps)
      ? rawPlan.steps.map((step, index) => ({
          ...step,
          id: step.id || "game-step-" + (index + 1),
          retries: Math.max(0, Number(step.retries ?? 1)),
          timeoutMs: Number(step.timeoutMs ?? 0)
        }))
      : []
  };
  assertGamePlan(plan);
  return plan;
}
