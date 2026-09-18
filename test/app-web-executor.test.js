import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-app-web-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-app-web-root-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { APP_WEB_STEP_KINDS } = await import("../src/app-web-domain.js");
const {
  buildAppWebExecutionPlan,
  executeAppWebTask,
  AppWebRuntime
} = await import("../src/app-web-executor.js");
const {
  DeterministicAppWebServiceAdapter,
  DeterministicBrowserAdapter,
  DeterministicDeploymentAdapter
} = await import("../src/testing-app-web-adapters.js");

async function makeAgent() {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "app-web-test-user",
    taskType: "website",
    title: "Niomi website execution",
    originalRequest: "Build a small website",
    specification: "Build a small website with tests and a build",
    requestedTools: ["filesystem", "shell", "git", "browser", "node", "deploy-web"],
    estimatedBudget: 10,
    maxBudget: 30,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "niomi",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes: [
        "workspace:read",
        "workspace:write",
        "process:execute",
        "git:read",
        "git:write",
        "browser:navigate",
        "browser:inspect",
        "browser:test",
        "deployment:deploy"
      ],
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
      text: "Execution succeeds",
      status: "pending"
    });
  });

  const agent = await spawnAgentForTask(task.id);
  return startAgent(agent.id);
}

test("Niomi builds and executes a repository, implementation, test, build and package plan", async () => {
  const agent = await makeAgent();
  const db = await loadDb();
  const workspace = db.workspaces.find(x => x.id === agent.workspaceId);

  const plan = {
    id: "app-web-e2e",
    version: 1,
    steps: [
      {
        id: "repo-init",
        kind: APP_WEB_STEP_KINDS.COMMAND,
        phase: "repository",
        executable: "git",
        args: ["init"],
        retries: 0,
        timeoutMs: 30000
      },
      {
        id: "mkdir-src",
        kind: APP_WEB_STEP_KINDS.WORKSPACE_MKDIR,
        phase: "implementation",
        path: "src",
        retries: 0
      },
      {
        id: "write-package",
        kind: APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE,
        phase: "implementation",
        path: "package.json",
        content: JSON.stringify({
          name: "niomi-test-site",
          private: true,
          scripts: {
            test: "node --test",
            build: "node -e \"require('fs').writeFileSync('dist.txt','built')\""
          }
        }),
        retries: 0
      },
      {
        id: "write-app",
        kind: APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE,
        phase: "implementation",
        path: "src/index.js",
        content: "exports.answer = 42;\n",
        retries: 0
      },
      {
        id: "write-test",
        kind: APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE,
        phase: "implementation",
        path: "index.test.js",
        content: "const test = require('node:test'); const assert = require('node:assert/strict'); const { answer } = require('./src/index.js'); test('app',()=>assert.equal(answer,42));\n",
        retries: 0
      },
      {
        id: "test",
        kind: APP_WEB_STEP_KINDS.COMMAND,
        phase: "test",
        executable: "npm",
        args: ["test"],
        retries: 1,
        timeoutMs: 120000
      },
      {
        id: "build",
        kind: APP_WEB_STEP_KINDS.COMMAND,
        phase: "build",
        executable: "npm",
        args: ["run", "build"],
        retries: 1,
        timeoutMs: 120000
      },
      {
        id: "package",
        kind: APP_WEB_STEP_KINDS.PACKAGE,
        phase: "package",
        retries: 1,
        timeoutMs: 120000
      }
    ]
  };

  const result = await executeAppWebTask({
    agentInstanceId: agent.id,
    workspaceRoot: workspace.path,
    plan
  });

  assert.equal(result.status, "completed", result.error || JSON.stringify(result));
  assert.equal(result.plan.steps.at(-1).state, "passed");

  const after = await loadDb();
  const run = after.executionRuns.find(x => x.id === result.runId);
  assert.equal(run.status, "completed");
  const checkpoint = after.stateCheckpoints.find(x => x.scopeId === result.runId);
  assert.ok(checkpoint);
  assert.equal(checkpoint.kind, "app_web_execution");

  const artifactDir = path.join(workspace.path, "artifacts");
  const { readdir } = await import("node:fs/promises");
  const artifacts = await readdir(artifactDir);
  assert.ok(artifacts.some(name => name.endsWith(".tgz")));
});

test("model-generated plan is read from the Niomi blackboard", async () => {
  const agent = await makeAgent();
  const plan = await buildAppWebExecutionPlan(agent.id);
  assert.equal(plan.source, "baseline");

  await transact(db => {
    db.agentBlackboards.push({
      id: id("bb"),
      agentInstanceId: agent.id,
      key: "execution.plan",
      value: JSON.stringify({
        id: "model-plan",
        version: 2,
        steps: [{
          id: "model-file",
          kind: APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE,
          path: "model.txt",
          content: "generated",
          retries: 0
        }]
      }),
      version: 1,
      source: "astra",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });

  const generated = await buildAppWebExecutionPlan(agent.id);
  assert.equal(generated.source, "model");
  assert.equal(generated.id, "model-plan");
  assert.equal(generated.steps[0].kind, APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE);
});

test("App/Web runtime blocks workspace escapes and supports service, smoke and deploy adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-runtime-root-"));
  const calls = [];
  const runtime = new AppWebRuntime({
    workspaceRoot: root,
    serviceAdapter: new DeterministicAppWebServiceAdapter({ calls }),
    browserAdapter: new DeterministicBrowserAdapter({ calls }),
    deploymentAdapter: new DeterministicDeploymentAdapter({ calls })
  });

  await assert.rejects(
    () => runtime.execute({
      id: "escape",
      kind: APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE,
      path: "../outside.txt",
      content: "blocked"
    }),
    /escapes the agent workspace/
  );

  const service = await runtime.execute({
    id: "db",
    kind: APP_WEB_STEP_KINDS.SERVICE,
    operation: "database_setup"
  });
  const smoke = await runtime.execute({
    id: "smoke",
    kind: APP_WEB_STEP_KINDS.BROWSER_SMOKE,
    url: "http://localhost:3000"
  });
  const deployment = await runtime.execute({
    id: "deploy",
    kind: APP_WEB_STEP_KINDS.DEPLOY,
    target: "test"
  });

  assert.equal(service.ok, true);
  assert.equal(smoke.ok, true);
  assert.equal(deployment.ok, true);
  assert.deepEqual(calls.map(x => x.type), ["service", "browser", "deploy"]);

  await rm(root, { recursive: true, force: true });
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
