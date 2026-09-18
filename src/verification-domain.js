export const VERIFICATION_STATUS = {
  PASSED: "passed",
  FAILED: "failed",
  BLOCKED: "blocked"
};

export const FAILURE_CATEGORIES = {
  ACCEPTANCE: "acceptance",
  EXECUTION: "execution",
  TEST: "test",
  BUILD: "build",
  SMOKE: "smoke",
  DEPLOYMENT: "deployment",
  ARTIFACT: "artifact",
  BUDGET: "budget",
  SECURITY: "security",
  ISOLATION: "isolation",
  INFRASTRUCTURE: "infrastructure"
};

export function classifyStepFailure(step = {}) {
  const text = [
    step.phase || "",
    step.kind || "",
    step.error || ""
  ].join(" ").toLowerCase();

  if (text.includes("deploy")) return FAILURE_CATEGORIES.DEPLOYMENT;
  if (text.includes("smoke") || text.includes("browser")) return FAILURE_CATEGORIES.SMOKE;
  if (text.includes("build") || text.includes("compile") || text.includes("cook")) return FAILURE_CATEGORIES.BUILD;
  if (text.includes("test")) return FAILURE_CATEGORIES.TEST;
  if (text.includes("artifact") || text.includes("package")) return FAILURE_CATEGORIES.ARTIFACT;
  if (text.includes("budget") || text.includes("spend")) return FAILURE_CATEGORIES.BUDGET;
  if (text.includes("workspace") || text.includes("permission") || text.includes("credential")) {
    return FAILURE_CATEGORIES.SECURITY;
  }
  return FAILURE_CATEGORIES.EXECUTION;
}
