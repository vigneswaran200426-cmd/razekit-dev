import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-verification-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-verification-root-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent, completeAgent } = await import("../src/agent-manager.js");
const { APP_WEB_STEP_KINDS } = await import("../src/app-web-domain.js");
const { verifyTask, latestVerification } = await import("../src/verification.js");

async function makeTask({ status = "pending", withRun = false } = {}) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "verification-user",
    taskType: "website",
    title: "Verification task",
    originalRequest: "Build a website",
    specification: "Build and test a website",
    requestedTools: ["filesystem", "shell", "git", "browser", "node"],
    estimatedBudget: 10,
    maxBudget: 50,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "niomi",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };

  const criterionId = id("ac");
  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({
      id: criterionId,
      taskId: task.id,
      text: "Task requirements satisfied",
      status,
      evidence: null
    });
  });

  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  if (withRun) {
    const workspace = dbWorkspace(await loadDb(), agent.workspaceId);
    await transact(db => {
      db.executionRuns.push({
        id: id("run"),
        taskId: task.id,
        agentInstanceId: agent.id,
        kind: "app_web",
        status: "completed",
        startedAt: now,
        completedAt: now,
        result: {
          status: "completed",
          plan: {
            id: "verified-plan",
            steps: [
              { id: "test", kind: APP_WEB_STEP_KINDS.COMMAND, phase: "test", state: "passed", result: { stdout: "tests passed" } },
              { id: "build", kind: APP_WEB_STEP_KINDS.COMMAND, phase: "build", state: "passed", result: { stdout: "build passed" } },
              { id: "smoke", kind: APP_WEB_STEP_KINDS.BROWSER_SMOKE, phase: "smoke", state: "passed", result: { ok: true } }
            ]
          }
        },
        error: null,
        artifacts: []
      });
      void workspace;
    });
  }

  return { task, agent, criterionId };
}

function dbWorkspace(db, workspaceId) {
  return db.workspaces.find(x => x.id === workspaceId);
}

test("verification fails without a completed execution run", async () => {
  const { agent } = await makeTask();
  const result = await verifyTask(agent.id, { requireArtifact: false });
  assert.equal(result.status, "failed");
  assert.ok(result.failures.length > 0);
  assert.equal((await latestVerification(agent.id)).status, "failed");
});

test("verification passes from completed execution evidence and passes acceptance criteria", async () => {
  const { agent } = await makeTask({ withRun: true });
  const result = await verifyTask(agent.id, { requireArtifact: false });
  assert.equal(result.status, "passed");

  const db = await loadDb();
  const criterion = db.acceptanceCriteria.find(x => x.taskId === agent.taskId);
  assert.equal(criterion.status, "passed");
  assert.equal(criterion.evidence.verifier, "razekit-dev-verification");
});

test("completion is gated by the verification result, not only mutable acceptance status", async () => {
  const { agent } = await makeTask({ status: "passed", withRun: false });
  await assert.rejects(
    () => completeAgent(agent.id),
    /verification|acceptance|complete/i
  );
});

test("verification rejects over-budget agents", async () => {
  const { agent } = await makeTask({ withRun: true });
  await transact(db => {
    const current = db.agentInstances.find(x => x.id === agent.id);
    current.budgetUsed = current.budgetLimit + 1;
  });
  const result = await verifyTask(agent.id, { requireArtifact: false });
  assert.equal(result.status, "failed");
  assert.equal(result.failures[0].category, "budget");
});

test("verification records a failed test/build step category", async () => {
  const { agent } = await makeTask({ withRun: true });
  await transact(db => {
    const run = db.executionRuns.find(x => x.agentInstanceId === agent.id);
    run.status = "failed";
    run.result.status = "failed";
    run.result.plan.steps[0].state = "failed";
    run.result.plan.steps[0].error = "test command failed";
  });

  const result = await verifyTask(agent.id, { requireArtifact: false });
  assert.equal(result.status, "failed");
  assert.ok(result.failures.some(x => x.category === "test" || x.category === "execution"));
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
