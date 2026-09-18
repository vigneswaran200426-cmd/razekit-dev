export const APP_WEB_STEP_KINDS = {
  WORKSPACE_WRITE_FILE: "workspace_write_file",
  WORKSPACE_MKDIR: "workspace_mkdir",
  COMMAND: "command",
  SERVICE: "service",
  BROWSER_SMOKE: "browser_smoke",
  DEPLOY: "deploy",
  PACKAGE: "package"
};

export const APP_WEB_PHASES = [
  "repository",
  "implementation",
  "test",
  "build",
  "smoke",
  "deployment",
  "package"
];

const SAFE_EXECUTABLES = new Set(["node", "npm", "git"]);

export function assertAppWebStep(step) {
  if (!step?.id) throw new Error("App/Web step id is required");
  if (!APP_WEB_STEP_KINDS[Object.keys(APP_WEB_STEP_KINDS).find(
    key => APP_WEB_STEP_KINDS[key] === step.kind
  )]) {
    throw new Error("Unsupported App/Web step kind: " + step.kind);
  }

  if (step.kind === APP_WEB_STEP_KINDS.COMMAND) {
    if (!SAFE_EXECUTABLES.has(String(step.executable || ""))) {
      throw new Error("App/Web executable is not allowed: " + step.executable);
    }
    if (!Array.isArray(step.args)) throw new Error("Command step args must be an array");
  }

  if (step.kind === APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE) {
    if (!step.path?.trim()) throw new Error("File write path is required");
    if (typeof step.content !== "string") throw new Error("File write content must be a string");
  }

  if (step.kind === APP_WEB_STEP_KINDS.WORKSPACE_MKDIR && !step.path?.trim()) {
    throw new Error("Directory path is required");
  }

  return step;
}

export function assertAppWebPlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("App/Web execution plan is required");
  if (!plan.id) throw new Error("App/Web execution plan id is required");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("App/Web execution plan must contain at least one step");
  }
  for (const step of plan.steps) assertAppWebStep(step);
  return plan;
}

export function normalizeModelExecutionPlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") return null;
  const steps = Array.isArray(rawPlan.steps) ? rawPlan.steps : [];
  const normalized = {
    id: rawPlan.id || "model-generated-app-web-plan",
    version: Number(rawPlan.version || 1),
    steps: steps.map((step, index) => ({
      ...step,
      id: step.id || "model-step-" + (index + 1),
      retries: Math.max(0, Number(step.retries ?? 1)),
      timeoutMs: Number(step.timeoutMs ?? 0)
    }))
  };
  assertAppWebPlan(normalized);
  return normalized;
}
