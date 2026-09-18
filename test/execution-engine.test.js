import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ExecutionEngine } from "../src/execution-engine.js";
import { EXECUTION_STEP_STATE } from "../src/runtime-domain.js";

class FakeRuntime {
  constructor() {
    this.calls = [];
    this.cancelled = false;
  }

  async execute(step) {
    this.calls.push(step.id);
    if (step.failOnce && this.calls.filter(id => id === step.id).length === 1) {
      throw new Error("first attempt failed");
    }
    return { ok: true, step: step.id };
  }

  cancel() {
    this.cancelled = true;
  }
}

test("execution engine retries failed steps and checkpoints progress", async () => {
  const runtime = new FakeRuntime();
  const checkpoints = [];

  const engine = new ExecutionEngine({
    runtime,
    checkpoint: async plan => checkpoints.push(JSON.parse(JSON.stringify(plan)))
  });

  const result = await engine.run({
    id: "plan-1",
    steps: [
      { id: "step-1", kind: "command", retries: 1, failOnce: true },
      { id: "step-2", kind: "command" }
    ]
  });

  assert.equal(result.status, "completed");
  assert.equal(result.plan.steps[0].state, EXECUTION_STEP_STATE.PASSED);
  assert.equal(result.plan.steps[1].state, EXECUTION_STEP_STATE.PASSED);
  assert.deepEqual(runtime.calls, ["step-1", "step-1", "step-2"]);
  assert.ok(checkpoints.length >= 3);
});

test("execution engine cancels cleanly", async () => {
  const runtime = new FakeRuntime();
  const engine = new ExecutionEngine({ runtime });

  engine.cancel();

  const result = await engine.run({
    id: "plan-cancelled",
    steps: [{ id: "step-1", kind: "command" }]
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.plan.steps[0].state, EXECUTION_STEP_STATE.CANCELLED);
  assert.equal(runtime.cancelled, true);
});

test("execution plan rejects empty plans", async () => {
  const engine = new ExecutionEngine({ runtime: new FakeRuntime() });
  await assert.rejects(
    () => engine.run({ id: "empty", steps: [] }),
    /at least one step/
  );
});
