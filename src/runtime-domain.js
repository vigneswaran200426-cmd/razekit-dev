export const WORKER_RUNTIME_STATE = {
  READY: "ready",
  LEASED: "leased",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed"
};

export const EXECUTION_STEP_STATE = {
  PENDING: "pending",
  RUNNING: "running",
  PASSED: "passed",
  FAILED: "failed",
  BLOCKED: "blocked",
  CANCELLED: "cancelled"
};

export function assertExecutionPlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Execution plan is required");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("Execution plan must contain at least one step");
  }
  for (const [index, step] of plan.steps.entries()) {
    if (!step?.id) throw new Error("Execution step " + index + " is missing id");
    if (!step?.kind) throw new Error("Execution step " + step.id + " is missing kind");
  }
  return plan;
}
