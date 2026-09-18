import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-loop-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-loop-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES, AGENT_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent, getAgent } = await import("../src/agent-manager.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { configureModelRegistry, MODEL_MODE } = await import("../src/model-providers.js");
const { advanceAgent, LOOP_STAGE } = await import("../src/autonomous-loop.js");
const { readBlackboard } = await import("../src/blackboard.js");
const { taskDashboard } = await import("../src/dashboard.js");

function orchestratorWithTestAdapters() {
  const registry = new ModelAdapterRegistry();
  const previous = process.env.RAZEKIT_MODEL_MODE;
  process.env.RAZEKIT_MODEL_MODE = MODEL_MODE.TEST;
  const configuration = configureModelRegistry(registry);
  if (previous === undefined) delete process.env.RAZEKIT_MODEL_MODE;
  else process.env.RAZEKIT_MODEL_MODE = previous;

  assert.equal(configuration.mode, MODEL_MODE.TEST);
  return new ModelOrchestrator({ registry });
}

async function makeTask(title, { taskType = "website", maxBudget = 5 } = {}) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "loop-user",
    tenantId: "loop-tenant",
    taskType,
    title,
    originalRequest: "Build " + title,
    specification: "Build " + title,
    requestedTools: ["filesystem", "node"],
    estimatedBudget: 1,
    maxBudget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: taskType === "game" ? AGENT_TYPES.KONAMI : AGENT_TYPES.NIOMI,
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
      text: "The site builds, tests pass and an artifact exists",
      status: "pending"
    });
  });

  return task;
}

// Drives the machine the way the coordinator does, one transition per call.
async function runToCompletion(agentId, orchestrator, { maxTransitions = 25 } = {}) {
  const stages = [];
  for (let i = 0; i < maxTransitions; i += 1) {
    const result = await advanceAgent(agentId, { orchestrator });
    stages.push(result.stage);
    if ([LOOP_STAGE.COMPLETED, LOOP_STAGE.BLOCKED].includes(result.stage)) return { stages, result };
    if (result.stage === LOOP_STAGE.IDLE && !result.retryable) return { stages, result };
  }
  throw new Error("Loop did not settle. Stages: " + stages.join(" -> "));
}

test("a website task runs plan -> implement -> execute -> review -> verify -> completed", async () => {
  const orchestrator = orchestratorWithTestAdapters();
  const task = await makeTask("Responsive landing page");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  const { stages, result } = await runToCompletion(agent.id, orchestrator);

  assert.equal(result.stage, LOOP_STAGE.COMPLETED, "expected the task to complete; stages: " + stages.join(" -> "));

  // Every stage of the documented machine actually ran.
  assert.ok(stages.includes(LOOP_STAGE.PLAN), "Astra never planned");
  assert.ok(stages.includes(LOOP_STAGE.IMPLEMENT), "Fable never implemented");
  assert.ok(stages.includes(LOOP_STAGE.EXECUTE), "the plan was never executed");
  assert.ok(stages.includes(LOOP_STAGE.REVIEW), "Astra never reviewed");

  const db = await loadDb();
  const finalTask = db.tasks.find(x => x.id === task.id);
  const finalAgent = db.agentInstances.find(x => x.id === agent.id);

  assert.equal(finalTask.status, TASK_STATUS.COMPLETED);
  assert.equal(finalAgent.status, AGENT_STATUS.COMPLETED);

  // Completion is verification-gated, not model-asserted.
  const verification = db.verificationRuns.filter(x => x.agentInstanceId === agent.id).pop();
  assert.equal(verification.status, "passed");
  assert.ok(db.acceptanceCriteria.filter(x => x.taskId === task.id).every(x => x.status === "passed"));

  // Real files, not a simulation.
  const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
  const html = await readFile(path.join(workspace.path, "index.html"), "utf8");
  assert.ok(html.includes("<nav"), "the workspace should hold the page that was built");
  const built = await readFile(path.join(workspace.path, "dist", "index.html"), "utf8");
  assert.ok(built.includes("<main"), "the build output should exist in the workspace");

  // Astra's architecture and Fable's execution plan are separate artifacts.
  const blackboard = await readBlackboard(agent.id);
  assert.ok(blackboard.some(x => x.key === "architecture.plan"), "Astra's plan should be on the blackboard");
  assert.ok(blackboard.some(x => x.key === "execution.plan"), "Fable's plan should be on the blackboard");
});

test("recorded deliverable paths do not depend on the worker's platform", async () => {
  const orchestrator = orchestratorWithTestAdapters();
  const task = await makeTask("Portable paths");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  await runToCompletion(agent.id, orchestrator);

  const dashboard = await taskDashboard(task.id);
  const paths = dashboard.deliverables.map(item => item.path);

  assert.ok(paths.length > 0, "the build should report deliverables");
  // A path recorded with the producing machine's separator makes the same task
  // look different depending on where it ran, and the dashboard, verification
  // and any download all read these off that machine.
  for (const item of paths) {
    assert.ok(!item.includes("\\"), `deliverable path must be POSIX, got: ${item}`);
  }
  assert.ok(
    paths.some(item => item.includes("test/")),
    "a nested path should be recorded with forward slashes: " + paths.join(", "),
  );
});

test("the hard budget stops the loop instead of overspending", async () => {
  const orchestrator = orchestratorWithTestAdapters();
  // The deterministic adapters spend 0.03 planning and 0.02 implementing, so a
  // 0.04 ceiling cannot survive the first two model calls.
  const task = await makeTask("Budget capped build", { maxBudget: 0.04 });
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  const { result } = await runToCompletion(agent.id, orchestrator);

  assert.equal(result.stage, LOOP_STAGE.BLOCKED);

  const db = await loadDb();
  const finalAgent = db.agentInstances.find(x => x.id === agent.id);
  assert.ok(
    Number(finalAgent.budgetUsed) <= Number(finalAgent.budgetLimit),
    "spend " + finalAgent.budgetUsed + " must never exceed the hard limit " + finalAgent.budgetLimit
  );
  assert.notEqual(finalAgent.status, AGENT_STATUS.COMPLETED);
});

test("a blocking review stops the task and asks the user", async () => {
  const registry = new ModelAdapterRegistry();
  registry.register("fable", {
    async generate() {
      return {
        output: "implemented",
        implementation: { status: "implemented", filesChanged: 0 },
        plan: {
          id: "blocking-plan",
          version: 1,
          steps: [{ id: "noop", kind: "command", phase: "repository", executable: "git", args: ["init"] }]
        },
        usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 }
      };
    }
  });
  registry.register("astra", {
    async generate(request) {
      if (request.role === "planner") {
        return {
          output: "planned",
          architecture: { summary: "plan", steps: [] },
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 }
        };
      }
      return {
        output: "blocked",
        review: {
          decision: "block",
          reason: "Stripe payments need an account and keys.",
          blockedOn: "Stripe API credentials and authorisation to take payments.",
          findings: []
        },
        usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 }
      };
    }
  });

  const orchestrator = new ModelOrchestrator({ registry });
  const task = await makeTask("Checkout with payments");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  const { result } = await runToCompletion(agent.id, orchestrator);

  assert.equal(result.stage, LOOP_STAGE.BLOCKED);
  assert.match(result.reason, /Stripe API credentials/);

  const dashboard = await taskDashboard(task.id);
  assert.equal(dashboard.status, "DECISION NEEDED");
  assert.ok(
    dashboard.events.some(event => /Stripe API credentials/.test(event.message)),
    "the user should be told what is needed"
  );
});

test("a failing execution sends the work back to Fable rather than completing", async () => {
  const registry = new ModelAdapterRegistry();
  let implementations = 0;

  registry.register("fable", {
    async generate() {
      implementations += 1;
      return {
        output: "implemented",
        implementation: { status: "implemented", filesChanged: 1 },
        plan: {
          id: "fable-plan-" + implementations,
          version: 1,
          steps: [
            {
              id: "write-package",
              kind: "workspace_write_file",
              phase: "implementation",
              path: "package.json",
              content: JSON.stringify({
                name: "recovering-build",
                version: "1.0.0",
                private: true,
                // The first attempt runs a script that exits non-zero; the
                // second one does not.
                scripts: { test: implementations === 1 ? "node -e \"process.exit(1)\"" : "node -e \"process.exit(0)\"" }
              })
            },
            {
              id: "run-tests",
              kind: "command",
              phase: "test",
              executable: "npm",
              args: ["test"],
              retries: 0,
              timeoutMs: 60000
            }
          ]
        },
        usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 }
      };
    }
  });

  registry.register("astra", {
    async generate(request) {
      if (request.role === "planner") {
        return {
          output: "planned",
          architecture: { summary: "plan", steps: [] },
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 }
        };
      }
      const execution = request.context?.blackboard?.find(entry => entry.key === "execution.lastResult");
      const ok = execution?.value?.status === "completed";
      return {
        output: ok ? "pass" : "revise",
        review: ok
          ? { decision: "pass", reason: "Tests pass.", findings: [] }
          : { decision: "revise", reason: "Tests failed.", findings: [{ severity: "high", detail: "npm test exited non-zero" }] },
        usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 }
      };
    }
  });

  const orchestrator = new ModelOrchestrator({ registry });
  const task = await makeTask("Self-correcting build");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  const { stages } = await runToCompletion(agent.id, orchestrator, { maxTransitions: 40 });

  assert.ok(implementations >= 2, "Fable should have been asked to fix the failure");

  const db = await loadDb();
  const runs = db.executionRuns.filter(x => x.agentInstanceId === agent.id);
  assert.ok(runs.length >= 2, "the plan should have been executed again after the fix; stages: " + stages.join(" -> "));
  assert.ok(runs.some(run => run.status === "failed"), "the first run should be recorded as failed");
});

test("two concurrent tasks keep separate workspaces, blackboards and budgets", async () => {
  const orchestrator = orchestratorWithTestAdapters();
  const taskA = await makeTask("Isolated A");
  const taskB = await makeTask("Isolated B");
  const agentA = await spawnAgentForTask(taskA.id);
  const agentB = await spawnAgentForTask(taskB.id);
  await startAgent(agentA.id);
  await startAgent(agentB.id);

  await runToCompletion(agentA.id, orchestrator);
  await runToCompletion(agentB.id, orchestrator);

  const fullA = await getAgent(agentA.id);
  const fullB = await getAgent(agentB.id);

  assert.notEqual(fullA.workspace.path, fullB.workspace.path);
  assert.notEqual(fullA.workerId, fullB.workerId);

  const boardA = await readBlackboard(agentA.id);
  const boardB = await readBlackboard(agentB.id);
  assert.ok(boardA.every(entry => entry.agentInstanceId === agentA.id));
  assert.ok(boardB.every(entry => entry.agentInstanceId === agentB.id));

  const db = await loadDb();
  const runsA = db.executionRuns.filter(x => x.agentInstanceId === agentA.id);
  const runsB = db.executionRuns.filter(x => x.agentInstanceId === agentB.id);
  assert.ok(runsA.length > 0 && runsB.length > 0);
  assert.equal(runsA.filter(run => runsB.some(other => other.id === run.id)).length, 0);
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
