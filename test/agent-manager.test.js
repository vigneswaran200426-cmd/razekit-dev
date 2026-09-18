import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, loadDb, id } = await import("../src/store.js");
const { buildPreflight, agentTypeForTask, AGENT_TYPES, TASK_STATUS, AGENT_STATUS } = await import("../src/domain.js");
const {
  spawnAgentForTask,
  startAgent,
  getAgent,
  recordSpend,
  completeAgent
} = await import("../src/agent-manager.js");

async function makeTask(taskType, maxBudget = 20) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "test-user",
    taskType,
    title: "Test task",
    originalRequest: "Build a deterministic test project",
    specification: "Build a deterministic test project",
    requestedTools: [],
    estimatedBudget: 1,
    maxBudget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: agentTypeForTask(taskType),
    agentInstanceId: null,
    deadline: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => db.tasks.push(task));
  return task;
}

test("routes app and website tasks to Niomi and games to Konami", () => {
  assert.equal(agentTypeForTask("app"), AGENT_TYPES.NIOMI);
  assert.equal(agentTypeForTask("website"), AGENT_TYPES.NIOMI);
  assert.equal(agentTypeForTask("game"), AGENT_TYPES.KONAMI);
  assert.equal(buildPreflight({taskType:"website", originalRequest:"build a site"}).predictedAgentType, AGENT_TYPES.NIOMI);
  assert.equal(buildPreflight({taskType:"game", originalRequest:"build a game"}).predictedAgentType, AGENT_TYPES.KONAMI);
});

test("each task gets its own independent agent, workspace and worker", async () => {
  const firstTask = await makeTask("website");
  const secondTask = await makeTask("game");
  const first = await spawnAgentForTask(firstTask.id);
  const second = await spawnAgentForTask(secondTask.id);

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.notEqual(first.workerId, second.workerId);
  assert.equal(first.agentType, AGENT_TYPES.NIOMI);
  assert.equal(second.agentType, AGENT_TYPES.KONAMI);

  await startAgent(first.id);
  await startAgent(second.id);
  assert.equal((await getAgent(first.id)).status, AGENT_STATUS.RUNNING);
  assert.equal((await getAgent(second.id)).status, AGENT_STATUS.RUNNING);
});

test("hard budget blocks spend beyond the configured ceiling", async () => {
  const task = await makeTask("app", 10);
  const agent = await spawnAgentForTask(task.id);
  await recordSpend(agent.id, 7, "test charge");
  assert.equal((await getAgent(agent.id)).budgetUsed, 7);

  await assert.rejects(
    () => recordSpend(agent.id, 4, "should exceed limit"),
    /Hard budget limit exceeded/
  );
  assert.equal((await getAgent(agent.id)).budgetUsed, 7);
});

test("completion requires acceptance criteria to pass", async () => {
  const task = await makeTask("app");
  const criterion = { id: id("ac"), taskId: task.id, text: "Build passes", status: "pending" };
  await transact(db => db.acceptanceCriteria.push(criterion));

  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  await assert.rejects(
    () => completeAgent(agent.id, "Should not complete yet"),
    /acceptance criteria pass/
  );

  const { setAcceptanceCriterion } = await import("../src/agent-manager.js");
  await setAcceptanceCriterion(task.id, criterion.id, "passed", "Test passed");

  const workspace = (await getAgent(agent.id)).workspace.path;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  await writeFile(path.join(workspace, "artifacts", "verified.tgz"), "artifact");

  await transact(db => {
    db.executionRuns.push({
      id: id("run"),
      taskId: task.id,
      agentInstanceId: agent.id,
      kind: "app_web",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: {
        status: "completed",
        plan: {
          id: "verified-completion-plan",
          steps: [
            { id: "test", kind: "command", phase: "test", state: "passed" },
            { id: "build", kind: "command", phase: "build", state: "passed" },
            {
              id: "package",
              kind: "package",
              phase: "package",
              state: "passed",
              result: { outputDir: "artifacts", files: ["verified.tgz"] }
            }
          ]
        }
      },
      error: null,
      artifacts: []
    });
  });

  const completed = await completeAgent(agent.id, "Test completed");

  assert.equal(completed.status, AGENT_STATUS.COMPLETED);
  assert.equal((await getAgent(agent.id)).task.status, TASK_STATUS.COMPLETED);
  assert.equal((await getAgent(agent.id)).worker.status, "stopped");
  assert.equal((await getAgent(agent.id)).workspace.status, "stopped");
});

test("state is persisted", async () => {
  const db = await loadDb();
  assert.equal(db.tasks.length, 4);
  assert.equal(db.agentInstances.length, 4);
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
