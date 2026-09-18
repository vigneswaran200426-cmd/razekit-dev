import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-model-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-model-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, loadDb, id } = await import("../src/store.js");
const { AGENT_STATUS, TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { readBlackboard, writeBlackboard } = await import("../src/blackboard.js");
const { listModelSessions } = await import("../src/model-sessions.js");

class FableTestAdapter {
  async generate(request) {
    return {
      output: "Fable implementation for " + request.context.task.title,
      implementation: { changed: ["src/app.js"] },
      usage: { inputTokens: 100, outputTokens: 80, cost: 0.02 }
    };
  }
}

class AstraTestAdapter {
  async generate(request) {
    if (request.role === "planner") {
      return {
        output: "Astra plan",
        plan: { steps: [{ id: "impl", kind: "implementation" }] },
        usage: { inputTokens: 120, outputTokens: 70, cost: 0.03 }
      };
    }
    return {
      output: "Astra review",
      review: { decision: "pass", findings: [] },
      usage: { inputTokens: 130, outputTokens: 60, cost: 0.035 }
    };
  }
}

async function makeTask(title) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "test-user",
    taskType: "website",
    title,
    originalRequest: "Build " + title,
    specification: "Build " + title,
    requestedTools: ["filesystem", "node"],
    estimatedBudget: 1,
    maxBudget: 5,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };

  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({
      id: id("ac"),
      taskId: task.id,
      text: "Required build/tests pass",
      status: "pending"
    });
  });

  return task;
}

test("per-agent sessions and blackboards stay isolated", async () => {
  const taskA = await makeTask("Project A");
  const taskB = await makeTask("Project B");
  const agentA = await spawnAgentForTask(taskA.id);
  const agentB = await spawnAgentForTask(taskB.id);

  assert.notEqual(agentA.id, agentB.id);
  await startAgent(agentA.id);
  await startAgent(agentB.id);

  const sessionsA = await listModelSessions(agentA.id);
  const sessionsB = await listModelSessions(agentB.id).catch(() => []);

  assert.deepEqual(sessionsA, []);
  assert.deepEqual(sessionsB, []);

  const registry = new ModelAdapterRegistry();
  registry.register("fable", new FableTestAdapter());
  registry.register("astra", new AstraTestAdapter());

  const orchestrator = new ModelOrchestrator({ registry });

  await orchestrator.provision(agentA.id);
  await orchestrator.provision(agentB.id);

  const aSessions = await listModelSessions(agentA.id);
  const bSessions = await listModelSessions(agentB.id);

  assert.equal(aSessions.length, 2);
  assert.equal(bSessions.length, 2);
  assert.notEqual(aSessions[0].id, bSessions[0].id);

  await writeBlackboard(agentA.id, "secret", "A");
  await writeBlackboard(agentB.id, "secret", "B");

  assert.equal((await readBlackboard(agentA.id)).find(x => x.key === "secret").value, "A");
  assert.equal((await readBlackboard(agentB.id)).find(x => x.key === "secret").value, "B");
});

test("Niomi orchestrator runs planner -> implementation -> review", async () => {
  const task = await makeTask("Orchestrated App");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  const registry = new ModelAdapterRegistry();
  registry.register("fable", new FableTestAdapter());
  registry.register("astra", new AstraTestAdapter());

  const orchestrator = new ModelOrchestrator({ registry });

  const first = await orchestrator.step(agent.id);
  assert.equal(first.run.status, "implementing");

  const second = await orchestrator.step(agent.id);
  assert.equal(second.run.status, "reviewing");

  const third = await orchestrator.step(agent.id);
  assert.equal(third.run.status, "completed");
  assert.equal(third.result.review.decision, "pass");

  const state = await orchestrator.getState(agent.id);
  assert.equal(state.sessions.length, 2);
  assert.ok(state.blackboard.some(x => x.key === "execution.plan"));
  assert.ok(state.blackboard.some(x => x.key === "implementation.result"));
  assert.ok(state.blackboard.some(x => x.key === "review.result"));

  const db = await loadDb();
  const sessionCosts = db.modelSessions
    .filter(x => x.agentInstanceId === agent.id)
    .reduce((sum, x) => sum + x.cost, 0);

  assert.equal(sessionCosts, 0.085);
  assert.equal(db.tasks.find(x => x.id === task.id).actualSpend, 0.085);
});

test("retryable model errors leave the orchestration retryable", async () => {
  const task = await makeTask("Retryable Project");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  let attempts = 0;
  const registry = new ModelAdapterRegistry();
  registry.register("fable", new FableTestAdapter());
  registry.register("astra", {
    async generate(request) {
      if (request.role === "planner" && attempts++ === 0) {
        const error = new Error("temporary model outage");
        error.retryable = true;
        throw error;
      }
      return new AstraTestAdapter().generate(request);
    }
  });

  const orchestrator = new ModelOrchestrator({ registry });

  await assert.rejects(
    () => orchestrator.step(agent.id),
    /temporary model outage/
  );

  const blocked = await orchestrator.getState(agent.id);
  assert.equal(blocked.run.status, "blocked");

  const recovered = await orchestrator.step(agent.id);
  assert.equal(recovered.run.status, "implementing");
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
