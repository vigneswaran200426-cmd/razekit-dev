import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-dashboard-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-dashboard-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { id, loadDb, transact } = await import("../src/store.js");
const { TASK_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const {
  USER_DASHBOARD_STATUS,
  changeAnalysis,
  submitUserCommand,
  approveChange,
  denyChange,
  taskDashboard
} = await import("../src/dashboard.js");

async function makeTask({ budget = 20 } = {}) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "dashboard-user",
    taskType: "website",
    title: "Dashboard test task",
    originalRequest: "Build a website",
    specification: "Build a website",
    requestedTools: [],
    estimatedBudget: 5,
    maxBudget: budget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "niomi",
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

  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({
      id: id("ac"),
      taskId: task.id,
      text: "Build passes",
      status: "pending",
      evidence: null
    });
  });

  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent };
}

test("change analysis treats visual refinements as safe and zero-cost", async () => {
  const { task, agent } = await makeTask();
  const result = changeAnalysis("Change homepage to dark mode with tighter spacing", task, agent);
  assert.equal(result.category, "in-scope");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.budget.estimatedIncrement, 0);
});

test("in-scope user changes apply while the agent keeps working", async () => {
  const { task, agent } = await makeTask();
  const result = await submitUserCommand(task.id, "Change homepage to dark mode");
  assert.equal(result.mode, "applied");

  const db = await loadDb();
  const savedTask = db.tasks.find(item => item.id === task.id);
  const savedAgent = db.agentInstances.find(item => item.id === agent.id);
  assert.match(savedTask.specification, /User change: Change homepage to dark mode/);
  assert.equal(savedAgent.status, "running");
  assert.equal(db.taskChangeRequests.find(item => item.id === result.change.id).status, "applied");
});

test("scope changes pause the task and surface a decision instead of silently expanding scope", async () => {
  const { task, agent } = await makeTask();
  const result = await submitUserCommand(task.id, "Use Razorpay instead of Stripe");
  assert.equal(result.mode, "decision_needed");
  assert.equal(result.change.impact, "high");

  const db = await loadDb();
  const savedTask = db.tasks.find(item => item.id === task.id);
  const savedAgent = db.agentInstances.find(item => item.id === agent.id);
  assert.equal(savedTask.status, "waiting_user");
  assert.equal(savedAgent.status, "waiting_user");
  assert.equal((db.taskChangeRequests.filter(item => item.taskId === task.id && item.status === "pending")).length, 1);

  const dashboard = await taskDashboard(task.id);
  assert.equal(dashboard.status, USER_DASHBOARD_STATUS.DECISION_NEEDED);
  assert.equal(dashboard.pendingDecisions.length, 1);
});

test("approving an in-budget scope change applies it and resumes the task", async () => {
  const { task } = await makeTask({ budget: 20 });
  const pending = await submitUserCommand(task.id, "Make the site multiplayer");
  const result = await approveChange(task.id, pending.change.id);

  assert.equal(result.change.status, "approved");
  const dashboard = await taskDashboard(task.id);
  assert.equal(dashboard.status, USER_DASHBOARD_STATUS.WORKING);
  assert.match(dashboard.task.specification, /User change: Make the site multiplayer/);
});

test("budget impact blocks approval until the hard budget is increased", async () => {
  const { task } = await makeTask({ budget: 5 });
  const pending = await submitUserCommand(task.id, "Make the site multiplayer");

  await assert.rejects(
    () => approveChange(task.id, pending.change.id),
    /increase maxBudget/
  );

  const result = await approveChange(task.id, pending.change.id, { maxBudget: 10 });
  assert.equal(result.change.status, "approved");
  assert.equal((await taskDashboard(task.id)).budget.maxBudget, 10);
});

test("declining a pending change resumes the previous work without applying it", async () => {
  const { task } = await makeTask();
  const pending = await submitUserCommand(task.id, "Add a new feature for team invitations");
  await denyChange(task.id, pending.change.id);

  const db = await loadDb();
  const change = db.taskChangeRequests.find(item => item.id === pending.change.id);
  const taskAfter = db.tasks.find(item => item.id === task.id);
  const agentAfter = db.agentInstances.find(item => item.id === taskAfter.agentInstanceId);
  assert.equal(change.status, "denied");
  assert.equal(agentAfter.status, "running");
  assert.doesNotMatch(taskAfter.specification, /team invitations/);
});

test("dashboard progress and deliverables are derived from execution evidence", async () => {
  const { task, agent } = await makeTask();
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
          id: "dashboard-plan",
          steps: [
            { id: "test", kind: "command", phase: "test", state: "passed" },
            { id: "build", kind: "command", phase: "build", state: "passed" },
            {
              id: "package",
              kind: "package",
              phase: "package",
              state: "passed",
              result: { outputDir: "artifacts", files: ["site.tgz"] }
            },
            { id: "smoke", kind: "browser_smoke", phase: "smoke", state: "running" }
          ]
        }
      },
      artifacts: []
    });
  });

  const dashboard = await taskDashboard(task.id);
  assert.equal(dashboard.progress.percent, 68);
  assert.equal(dashboard.progress.steps.passed, 3);
  assert.ok(dashboard.deliverables.some(item => item.path === "site.tgz"));
});

test("dashboard chat hides low-level tool and test events", async () => {
  const { task, agent } = await makeTask();
  await transact(db => {
    db.agentMessages.push(
      {
        id: id("msg"),
        agentInstanceId: agent.id,
        role: "system",
        content: "tool filesystem read",
        metadata: { toolCall: true },
        createdAt: new Date().toISOString()
      },
      {
        id: id("msg"),
        agentInstanceId: agent.id,
        role: "system",
        content: "test assertion 1 passed",
        metadata: { testEvent: true },
        createdAt: new Date().toISOString()
      }
    );
  });

  const dashboard = await taskDashboard(task.id);
  assert.equal(dashboard.chat.some(item => item.content === "tool filesystem read"), false);
  assert.equal(dashboard.chat.some(item => item.content === "test assertion 1 passed"), false);
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
