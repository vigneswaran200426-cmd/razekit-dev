import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Changing a task that is already running.
//
// The dangerous version of this feature rebuilds the graph. That looks tidy and
// charges the user twice: the completed nodes were paid for, and a change
// arriving afterwards is not a reason to buy the same build again. So a replan
// APPENDS — it decides what happens next and cannot reach backwards.
//
// The other thing it must not do is widen anything. A change is a change of
// shape. If it could also grant a scope or raise a ceiling, "approve this
// change" would be an authorization prompt in disguise.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-replan-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-replan-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";
process.env.RAZEKIT_MODEL_NODE_COST = "1";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { advanceAgent, LOOP_STAGE } = await import("../src/autonomous-loop.js");
const { graphForTask, cancelGraph } = await import("../src/jev.js");
const { graphCycles, producerKeyFor, expandWithReplan } = await import("../src/jev-model-graph.js");
const { replanRunningGraph } = await import("../src/jev-model-loop.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeTask({ toolScopes = [] } = {}) {
  seq += 1;
  const tenantId = "tenant-replan-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "replan-user",
    taskType: "website",
    title: "Replan " + seq,
    originalRequest: "Build a landing page",
    specification: "Build a landing page",
    requestedTools: ["filesystem"],
    estimatedBudget: 1,
    maxBudget: 40,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes,
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({ id: id("ac"), taskId: task.id, text: "It exists", status: "pending" });
  });
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

function harness({ reviewDecisions = ["pass"] } = {}) {
  let reviewIndex = 0;
  let implementations = 0;
  const calls = [];

  const registry = new ModelAdapterRegistry();
  registry.register("astra", {
    async generate(request) {
      calls.push(request.role + ":" + (request.context?.node?.key || "?"));
      if (request.role === "planner") {
        return { output: "planned", architecture: { summary: "a page", steps: [] }, usage: { cost: 0.01 } };
      }
      const decision = reviewDecisions[Math.min(reviewIndex, reviewDecisions.length - 1)];
      reviewIndex += 1;
      return {
        output: "reviewed",
        review: { decision, reason: "decision " + decision, findings: [] },
        usage: { cost: 0.01 }
      };
    }
  });
  registry.register("fable", {
    async generate(request) {
      calls.push("implementer:" + (request.context?.node?.key || "?"));
      implementations += 1;
      return {
        output: "implemented",
        implementation: { status: "implemented", filesChanged: 1 },
        plan: {
          id: "plan-" + implementations,
          version: implementations,
          steps: [{
            id: "write-" + implementations,
            kind: "workspace_write_file",
            path: "page-" + implementations + ".html",
            content: "<main>v" + implementations + "</main>"
          }]
        },
        usage: { cost: 0.02 }
      };
    }
  });

  return {
    registry,
    calls,
    orchestrator: new ModelOrchestrator({ registry }),
    get implementations() { return implementations; }
  };
}

async function run(agentId, orchestrator, { maxTransitions = 40 } = {}) {
  const stages = [];
  for (let i = 0; i < maxTransitions; i += 1) {
    const result = await advanceAgent(agentId, { orchestrator });
    stages.push(result.stage);
    if ([LOOP_STAGE.COMPLETED, LOOP_STAGE.BLOCKED].includes(result.stage)) return { stages, result };
    if (result.stage === LOOP_STAGE.IDLE && !result.retryable) return { stages, result };
  }
  throw new Error("did not settle: " + stages.join(" -> "));
}

// ── The cycle rule itself ────────────────────────────────────────────────────

test("cycles are derived from the keys, not from counting reviews", () => {
  const nodes = [
    { key: "astra-plan" },
    { key: "fable-implement" },
    { key: "exec1:write" },
    { key: "astra-review-1" },
    { key: "fable-rework-1" },
    { key: "exec2:write" }
  ];
  const cycles = graphCycles(nodes);

  assert.equal(cycles.highestExec, 2);
  assert.equal(cycles.highestReview, 1);
  // fable-implement is the producer of cycle 1 and therefore index 0, so
  // "the producer of cycle K has index K-1" holds without a special case.
  assert.equal(cycles.highestProducer, 1);

  const byKey = new Map(nodes.map(node => [node.key, node]));
  assert.equal(producerKeyFor(1, byKey), "fable-implement");
  // A rework produces a cycle exactly as a repair does. The old rule, which
  // counted review nodes, could not see this one at all.
  assert.equal(producerKeyFor(2, byKey), "fable-rework-1");
  assert.equal(producerKeyFor(3, byKey), null);
});

test("a repair is preferred over a rework at the same index", () => {
  const nodes = [{ key: "fable-repair-2" }, { key: "fable-rework-2" }];
  const byKey = new Map(nodes.map(node => [node.key, node]));
  // Both cannot exist in a graph this code builds, but if they did, the repair
  // is the one the review asked for.
  assert.equal(producerKeyFor(3, byKey), "fable-repair-2");
});

// ── The replan, end to end through the live loop ─────────────────────────────

test("a change appends new work and leaves completed work exactly as it was", async () => {
  const { task, agent, tenantId } = await makeTask();
  const h = harness();

  const first = await run(agent.id, h.orchestrator);
  assert.equal(first.result.stage, LOOP_STAGE.COMPLETED, first.stages.join(" -> "));

  const before = await graphForTask({ taskId: task.id, tenantId, includeFinished: true });
  const snapshot = before.nodes.map(node => ({
    key: node.key,
    status: node.status,
    attempt: node.attempt,
    finishedAt: node.finishedAt,
    cost: node.output?.costMinor ?? null
  }));
  const implementationsBefore = h.implementations;

  const replan = await replanRunningGraph({
    taskId: task.id,
    tenantId,
    reason: "add a contact form",
    instructionVersion: 2
  });

  assert.equal(replan.replanned, true);
  assert.equal(replan.replanKey, "astra-replan-1");
  assert.equal(replan.reworkKey, "fable-rework-1");

  const after = await graphForTask({ taskId: task.id, tenantId, includeFinished: true });

  // Every node that existed before is byte-for-byte as it was. This is the
  // assertion that stops a replan from being a rebuild.
  for (const node of snapshot) {
    const current = after.nodes.find(item => item.key === node.key);
    assert.ok(current, "a completed node disappeared: " + node.key);
    assert.equal(current.status, node.status, node.key + " changed status");
    assert.equal(current.attempt, node.attempt, node.key + " changed attempt");
    assert.equal(current.finishedAt, node.finishedAt, node.key + " changed its finish time");
    assert.equal(current.output?.costMinor ?? null, node.cost, node.key + " changed cost");
  }

  // The graph reopened, and the new work sits after everything that was done.
  assert.ok(after.nodes.length > snapshot.length);
  const replanNode = after.nodes.find(node => node.key === "astra-replan-1");
  assert.deepEqual(
    replanNode.dependsOn.sort(),
    ["model-verify-1"],
    "the replan did not wait for the work in flight"
  );

  // And it actually runs: the loop picks it up and finishes the new cycle.
  const second = await run(agent.id, h.orchestrator, { maxTransitions: 50 });
  assert.equal(second.result.stage, LOOP_STAGE.COMPLETED, second.stages.join(" -> "));

  const final = await graphForTask({ taskId: task.id, tenantId, includeFinished: true });
  assert.ok(final.nodes.some(node => node.key.startsWith("exec2:")), "no second execution cycle ran");
  assert.equal(h.implementations, implementationsBefore + 1, "the rework re-ran the original implementation");
});

test("a second change while the first is still pending folds into it", async () => {
  const { task, agent, tenantId } = await makeTask();
  const h = harness();
  await run(agent.id, h.orchestrator);

  const first = await replanRunningGraph({ taskId: task.id, tenantId, reason: "change one", instructionVersion: 2 });
  assert.equal(first.replanned, true);

  const second = await replanRunningGraph({ taskId: task.id, tenantId, reason: "change two", instructionVersion: 3 });
  assert.equal(second.replanned, false);
  assert.equal(second.reason, "a replan is already pending");

  // One pair, not two. The rework reads the current instruction version, which
  // already contains both changes; a second pair would do the work twice.
  const view = await graphForTask({ taskId: task.id, tenantId, includeFinished: true });
  assert.equal(view.nodes.filter(node => node.key.startsWith("astra-replan-")).length, 1);
  assert.equal(view.nodes.filter(node => node.key.startsWith("fable-rework-")).length, 1);
});

test("two changes in sequence each get their own cycle", async () => {
  const { task, agent, tenantId } = await makeTask();
  const h = harness();

  await run(agent.id, h.orchestrator);
  await replanRunningGraph({ taskId: task.id, tenantId, reason: "change one", instructionVersion: 2 });
  await run(agent.id, h.orchestrator, { maxTransitions: 50 });

  const mid = await graphForTask({ taskId: task.id, tenantId, includeFinished: true });
  assert.equal(graphCycles(mid.nodes).highestExec, 2);

  const again = await replanRunningGraph({ taskId: task.id, tenantId, reason: "change two", instructionVersion: 3 });
  assert.equal(again.replanned, true);
  assert.equal(again.reworkKey, "fable-rework-2", "the second change reused the first change's cycle");

  await run(agent.id, h.orchestrator, { maxTransitions: 60 });

  const final = await graphForTask({ taskId: task.id, tenantId, includeFinished: true });
  assert.equal(graphCycles(final.nodes).highestExec, 3);
  // Three separate execution cycles, each with its own review — the history of
  // what was asked for and when is still readable from the graph alone.
  assert.equal(final.nodes.filter(node => node.key.startsWith("astra-review-")).length, 3);
});

test("a change to a task whose build failed is still applied", async () => {
  const { task, agent, tenantId } = await makeTask();
  // Never satisfied, so the task blocks at the repair ceiling with failures in
  // the graph. A change arriving then is exactly when a user is most likely to
  // send one.
  const previous = process.env.RAZEKIT_MAX_REPAIR_CYCLES;
  process.env.RAZEKIT_MAX_REPAIR_CYCLES = "1";
  try {
    const h = harness({ reviewDecisions: ["revise"] });
    const blocked = await run(agent.id, h.orchestrator, { maxTransitions: 60 });
    assert.equal(blocked.result.stage, LOOP_STAGE.BLOCKED);

    const replan = await replanRunningGraph({
      taskId: task.id, tenantId, reason: "try a different approach", instructionVersion: 2
    });
    assert.equal(replan.replanned, true, "a change could not be applied to a stopped task");
  } finally {
    if (previous === undefined) delete process.env.RAZEKIT_MAX_REPAIR_CYCLES;
    else process.env.RAZEKIT_MAX_REPAIR_CYCLES = previous;
  }
});

test("a cancelled graph refuses a replan", async () => {
  const { task, agent, tenantId } = await makeTask();
  const h = harness();
  await advanceAgent(agent.id, { orchestrator: h.orchestrator });

  const view = await graphForTask({ taskId: task.id, tenantId });
  await cancelGraph({ graphId: view.graph.id, reason: "stopped by the user" });

  const replan = await replanRunningGraph({ taskId: task.id, tenantId, reason: "one more thing" });

  // Someone stopped this on purpose. Restarting it because a change arrived
  // afterwards would spend money against a decision already made.
  assert.equal(replan.replanned, false);
  assert.equal(replan.reason, "graph-cancelled");
});

test("a task with no graph yet reports that rather than inventing one", async () => {
  const { task, tenantId } = await makeTask();
  const replan = await replanRunningGraph({ taskId: task.id, tenantId, reason: "early change" });

  assert.equal(replan.replanned, false);
  assert.equal(replan.reason, "no-graph");
});

// ── Safety ───────────────────────────────────────────────────────────────────

test("a replan cannot widen authorization or budget", async () => {
  const { task, agent, tenantId } = await makeTask();
  const h = harness();
  await run(agent.id, h.orchestrator);

  const db = await loadDb();
  const beforeAuth = JSON.stringify(db.tasks.find(item => item.id === task.id).authorization);
  const beforeLimit = Number(db.agentInstances.find(item => item.id === agent.id).budgetLimit);
  const beforeMax = Number(db.tasks.find(item => item.id === task.id).maxBudget);

  await replanRunningGraph({ taskId: task.id, tenantId, reason: "do much more", instructionVersion: 2 });

  const after = await loadDb();
  assert.equal(
    JSON.stringify(after.tasks.find(item => item.id === task.id).authorization), beforeAuth,
    "a replan changed what the task is authorized to do"
  );
  assert.equal(Number(after.agentInstances.find(item => item.id === agent.id).budgetLimit), beforeLimit);
  assert.equal(Number(after.tasks.find(item => item.id === task.id).maxBudget), beforeMax);

  // The nodes it added declare no scopes of their own, so nothing it produces
  // can reach past what the task was already allowed to do.
  const view = await graphForTask({ taskId: task.id, tenantId, includeFinished: true });
  for (const key of ["astra-replan-1", "fable-rework-1"]) {
    const node = view.nodes.find(item => item.key === key);
    assert.deepEqual(node.toolScopes, [], key + " declared tool scopes");
  }
});

test("expandWithReplan refuses to touch a graph it was not given", async () => {
  await assert.rejects(
    () => expandWithReplan({ graphId: "graph_nope", nodes: [{ key: "a", dependsOn: [] }] }),
    /Unknown execution graph/i
  );
});
