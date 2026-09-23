import { strict as assert } from "node:assert";
import test from "node:test";

const { compileNodeContext } = await import("../src/model-context.js");

const TASK = {
  id: "task_1",
  taskType: "website",
  title: "Landing page",
  originalRequest: "Build a landing page with a contact form",
  specification: "It must have a contact form and pass its tests"
};

const AGENT = { id: "agent_1", agentType: "niomi" };

function node(overrides = {}) {
  return {
    key: "fable-repair-1",
    kind: "model_repair",
    attempt: 1,
    dependsOn: ["astra-review-1"],
    description: "Repair the implementation",
    payload: { prompt: "Repair the implementation using the review findings." },
    ...overrides
  };
}

const REVIEW_NODE = {
  key: "astra-review-1",
  kind: "model_review",
  output: {
    structured: {
      review: {
        decision: "revise",
        reason: "The contact form does not submit.",
        findings: Array.from({ length: 40 }, (_, i) => ({
          severity: "high",
          detail: "finding " + i + " " + "x".repeat(400)
        }))
      }
    }
  }
};

test("the task requirements and the node's instruction survive every level of compaction", () => {
  const { context, compaction } = compileNodeContext({
    agent: AGENT,
    task: TASK,
    node: node(),
    graphNodes: [REVIEW_NODE],
    blackboard: Array.from({ length: 50 }, (_, i) => ({
      key: "execution.plan.note" + i,
      value: "y".repeat(2000)
    })),
    maxChars: 3000
  });

  assert.ok(compaction.compacted, "this input should not have fitted");
  assert.equal(context.task.specification, TASK.specification);
  assert.equal(context.task.request, TASK.originalRequest);
  assert.equal(context.node.instruction, "Repair the implementation using the review findings.");
});

test("a dependency is still represented after its detail is summarised", () => {
  const { context, compaction } = compileNodeContext({
    agent: AGENT,
    task: TASK,
    node: node(),
    graphNodes: [REVIEW_NODE],
    blackboard: [],
    maxChars: 3000
  });

  assert.ok(compaction.summarized, "the oversized review was not summarised");
  assert.equal(context.upstream.length, 1, "the dependency was dropped instead of summarised");

  const review = context.upstream[0].structured.review;
  // The decision is what branches the graph. Losing it to save space would be
  // losing the only part that matters.
  assert.equal(review.decision, "revise");
  assert.ok(review.findings.length > 0 && review.findings.length <= 10);
});

test("prose summaries of past model calls never reach a model node", () => {
  const { context } = compileNodeContext({
    agent: AGENT,
    task: TASK,
    node: node(),
    graphNodes: [],
    blackboard: [
      { key: "model.node.astra-plan.summary", value: "a long transcript" },
      { key: "review.result", value: { decision: "revise" } },
      { key: "some.unrelated.key", value: "noise" }
    ]
  });

  const keys = context.blackboard.map(entry => entry.key);
  assert.ok(!keys.includes("model.node.astra-plan.summary"), "a model transcript was forwarded");
  assert.ok(!keys.includes("some.unrelated.key"), "an unlisted key was forwarded");
  assert.ok(keys.includes("review.result"), "a decision the node needs was dropped");
});

test("verification evidence is part of the core for the node that interprets it", () => {
  const evidence = { verificationId: "verify_1", status: "failed", failures: [{ reason: "tests failed" }] };
  const { context } = compileNodeContext({
    agent: AGENT,
    task: TASK,
    node: node({ key: "model-verify-1", kind: "model_verify", payload: { prompt: "Interpret.", evidence } }),
    graphNodes: [],
    blackboard: [],
    // Far below the size of the input, so this only passes if evidence is core.
    maxChars: 2000
  });

  assert.deepEqual(context.evidence, evidence);
});

test("a context that cannot be made to fit says so instead of trimming the requirements", () => {
  const { context, compaction } = compileNodeContext({
    agent: AGENT,
    task: { ...TASK, specification: "s".repeat(5000) },
    node: node(),
    graphNodes: [],
    blackboard: [],
    maxChars: 2000
  });

  assert.equal(compaction.overBudget, true, "an over-budget context was reported as fitting");
  assert.equal(context.task.specification.length, 5000, "the requirements were trimmed to make them fit");
});

test("a context that fits is not compacted at all", () => {
  const { context, compaction } = compileNodeContext({
    agent: AGENT,
    task: TASK,
    node: node(),
    graphNodes: [],
    blackboard: [{ key: "review.result", value: { decision: "pass" } }],
    maxChars: 24000
  });

  assert.equal(compaction.compacted, false);
  assert.equal(compaction.overBudget, false);
  assert.equal(context.blackboard.length, 1);
});
