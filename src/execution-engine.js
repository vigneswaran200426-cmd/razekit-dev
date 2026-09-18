import { assertExecutionPlan, EXECUTION_STEP_STATE } from "./runtime-domain.js";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ExecutionEngine {
  constructor({ runtime, checkpoint, onStepEvent } = {}) {
    if (!runtime || typeof runtime.execute !== "function") {
      throw new Error("Execution runtime adapter is required");
    }
    this.runtime = runtime;
    this.checkpoint = typeof checkpoint === "function" ? checkpoint : async () => {};
    this.onStepEvent = typeof onStepEvent === "function" ? onStepEvent : async () => {};
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    if (typeof this.runtime.cancel === "function") this.runtime.cancel();
  }

  async run(plan, context = {}) {
    assertExecutionPlan(plan);

    const working = JSON.parse(JSON.stringify(plan));
    const startedAt = new Date().toISOString();

    for (const step of working.steps) {
      if (this.cancelled) {
        step.state = EXECUTION_STEP_STATE.CANCELLED;
        await this.checkpoint(working);
        return { status: "cancelled", plan: working };
      }

      if (step.state === EXECUTION_STEP_STATE.PASSED) continue;

      step.state = EXECUTION_STEP_STATE.RUNNING;
      step.startedAt = new Date().toISOString();
      await this.onStepEvent({ type: "step_started", step });
      await this.checkpoint(working);

      const attempts = Math.max(1, Number(step.retries ?? 0) + 1);
      let lastError = null;
      let passed = false;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (this.cancelled) break;
        step.attempt = attempt;

        try {
          const result = await this.runWithTimeout(() =>
            this.runtime.execute(step, {
              ...context,
              planId: plan.id,
              stepId: step.id,
              attempt
            }),
            Number(step.timeoutMs ?? context.defaultTimeoutMs ?? 0)
          );

          step.result = result ?? null;
          step.state = EXECUTION_STEP_STATE.PASSED;
          step.completedAt = new Date().toISOString();
          passed = true;
          await this.onStepEvent({ type: "step_passed", step, result });
          break;
        } catch (error) {
          lastError = error;
          step.error = error.message || "Execution step failed";
          await this.onStepEvent({ type: "step_failed", step, error, attempt });

          if (attempt < attempts) {
            await sleep(Math.min(5000, 250 * attempt));
          }
        }
      }

      if (!passed) {
        if (this.cancelled) {
          step.state = EXECUTION_STEP_STATE.CANCELLED;
          await this.checkpoint(working);
          return { status: "cancelled", plan: working };
        }

        step.state = EXECUTION_STEP_STATE.FAILED;
        step.failedAt = new Date().toISOString();
        await this.checkpoint(working);
        return {
          status: "failed",
          plan: working,
          error: lastError?.message || step.error || "Execution step failed"
        };
      }

      await this.checkpoint(working);
    }

    working.status = "completed";
    working.startedAt = startedAt;
    working.completedAt = new Date().toISOString();
    await this.checkpoint(working);
    return { status: "completed", plan: working };
  }

  async runWithTimeout(fn, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) return fn();

    let timer;
    let settled = false;

    const operation = Promise.resolve().then(fn).finally(() => {
      settled = true;
      if (timer) clearTimeout(timer);
    });

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        if (typeof this.runtime.cancel === "function") this.runtime.cancel();
        reject(new Error("Execution step timed out"));
      }, timeoutMs);
    });

    return Promise.race([operation, timeout]);
  }
}
