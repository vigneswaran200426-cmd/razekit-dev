import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The worker process.
//
// A lease exists so that a worker dying is survivable. Until there was a worker
// separate from the control plane, that could only ever be simulated. These
// tests drive the real worker loop: it claims from the graph, holds its lease
// while it works, and a node it abandons is recovered by another worker rather
// than by the process that scheduled it.
//
// Cross-PROCESS atomicity is deliberately not asserted here. The JSON store is
// atomic only within one process, and claiming that property from a test that
// cannot exhibit it would be worse than not testing it. It is proven against
// real Neon in the postgres suites.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-worker-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-worker-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent, getAgent } = await import("../src/agent-manager.js");
const { ensureTenant, tenantForTask } = await import("../src/tenant-security.js");
const { createTaskGraph, claimNextNode, claimableGraphWork, graphForTask } = await import("../src/jev.js");
const { runWorker, runWorkerOnce } = await import("../src/jev-worker.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { advanceAgent, LOOP_STAGE } = await import("../src/autonomous-loop.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeGraph(nodes) {
  seq += 1;
  const tenantId = "tenant-worker-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "worker-user",
    taskType: "website",
    title: "Worker " + seq,
    originalRequest: "Build it",
    specification: "Build it",
    requestedTools: ["filesystem"],
    estimatedBudget: 1,
    maxBudget: 20,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes: [],
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => db.tasks.push(task));
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  const created = await createTaskGraph({
    tenantId,
    userId: task.userId,
    taskId: task.id,
    agentInstanceId: agent.id,
    nodes
  });

  return { task, agent, tenantId, graph: created.graph };
}

function writeNode(key, file, dependsOn = []) {
  return {
    key,
    kind: "workspace_write_file",
    description: "write " + file,
    dependsOn,
    // The payload IS the step the runtime executes, kind included — that is the
    // contract jev-planner produces and the executor consumes.
    payload: { id: key, kind: "workspace_write_file", path: file, content: "from " + key },
    toolScopes: []
  };
}

test("a worker claims graph work, runs it and settles it", async () => {
  const { agent, tenantId } = await makeGraph([
    writeNode("a", "a.txt"),
    writeNode("b", "b.txt", ["a"])
  ]);

  const stats = await runWorker({ workerId: "worker-1", maxIterations: 5, pollMs: 1, sweep: false });

  assert.equal(stats.succeeded, 2, JSON.stringify(stats));

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  assert.equal(view.graph.status, "succeeded");
  // The work is real: the files exist because the worker wrote them.
  const current = await getAgent(agent.id);
  const workspace = (await loadDb()).workspaces.find(w => w.id === current.workspaceId);
  assert.equal(await readFile(path.join(workspace.path, "a.txt"), "utf8"), "from a");
  assert.equal(await readFile(path.join(workspace.path, "b.txt"), "utf8"), "from b");

  // Each node records the worker that actually ran it, not the scheduler.
  const db = await loadDb();
  const nodes = db.graphNodes.filter(n => n.graphId === view.graph.id);
  assert.ok(nodes.every(n => n.leaseOwner === "worker-1"), JSON.stringify(nodes.map(n => n.leaseOwner)));
});

test("a worker holds its lease open while a node runs longer than the lease", async () => {
  const { agent, tenantId } = await makeGraph([writeNode("slow", "slow.txt")]);

  // A lease far shorter than the work. Without renewal this node is stale
  // before it finishes, and the sweeper takes it away mid-write.
  const leaseMs = 600;
  let initialExpiry = null;
  let renewedExpiry = null;

  // The delay has to happen INSIDE node execution, after the claim — a delay
  // before the claim would prove nothing about the lease. And the wait is for
  // the renewal to be OBSERVED rather than for a fixed number of milliseconds,
  // so a slow machine makes this test slower rather than flaky.
  const runtime = {
    async execute(step) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const db = await loadDb();
        const node = db.graphNodes.find(item => item.key === "slow" && item.taskId === agent.taskId);
        if (initialExpiry === null) initialExpiry = node.leaseExpiresAt;
        else if (Date.parse(node.leaseExpiresAt) > Date.parse(initialExpiry)) {
          renewedExpiry = node.leaseExpiresAt;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { operation: step.kind, path: step.path };
    }
  };

  const result = await runWorkerOnce({ workerId: "worker-slow", leaseMs, runtime });

  assert.ok(renewedExpiry, "the lease was never renewed while the node was running");
  assert.ok(Date.parse(renewedExpiry) > Date.parse(initialExpiry));
  assert.equal(result.status, "succeeded");
  assert.equal(result.leaseLost, false, "the worker lost its own lease while still working");

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  assert.equal(view.nodes.find(n => n.key === "slow").status, "succeeded");
});

test("a node abandoned by one worker is recovered and completed by another", async () => {
  const { agent, tenantId } = await makeGraph([writeNode("orphan", "orphan.txt")]);

  // Claim it the way a worker does, then walk away — the worker died.
  const claim = await claimNextNode({
    taskId: agent.taskId,
    tenantId,
    workerId: "worker-that-dies",
    leaseMs: 1,
    now: new Date(Date.now() - 60_000)
  });
  assert.ok(claim, "nothing was claimable");

  // Nothing is claimable while the dead worker's lease is still recorded.
  const before = await claimableGraphWork({});
  assert.ok(
    !before.some(item => item.taskId === agent.taskId),
    "a leased node was offered to a second worker without being recovered first"
  );

  const stats = await runWorker({ workerId: "worker-that-lives", maxIterations: 3, pollMs: 1, sweep: true });

  assert.ok(stats.swept >= 1, "the stalled node was never recovered");
  assert.equal(stats.succeeded, 1, JSON.stringify(stats));

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  const node = view.nodes.find(n => n.key === "orphan");
  assert.equal(node.status, "succeeded");
  assert.equal(node.leaseOwner, "worker-that-lives");
  // The second attempt is recorded as a second attempt, not disguised as a first.
  assert.equal(Number(node.attempt), 2);
});

test("a worker told to stop finishes the node it holds rather than abandoning it", async () => {
  const { agent, tenantId } = await makeGraph([
    writeNode("first", "first.txt"),
    writeNode("second", "second.txt", ["first"])
  ]);

  const controller = new AbortController();
  let completedWhileStopping = 0;

  const stats = await runWorker({
    workerId: "worker-stopping",
    pollMs: 1,
    sweep: false,
    signal: controller.signal,
    onResult: async result => {
      // Told to stop the moment the first node settles.
      if (result.status === "succeeded") completedWhileStopping += 1;
      controller.abort();
    }
  });

  assert.equal(completedWhileStopping, 1);
  assert.equal(stats.succeeded, 1, "stopping should not have started a second node");

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  // The first is done and settled; the second is untouched and still claimable
  // by whatever picks the task up next.
  assert.equal(view.nodes.find(n => n.key === "first").status, "succeeded");
  assert.equal(view.nodes.find(n => n.key === "second").status, "ready");
});

test("claimable work is a read, not a claim, and excludes settled graphs", async () => {
  const { agent, tenantId } = await makeGraph([writeNode("only", "only.txt")]);

  const before = await claimableGraphWork({});
  assert.ok(before.some(item => item.taskId === agent.taskId));

  await runWorker({ workerId: "worker-drain", maxIterations: 3, pollMs: 1, sweep: false });

  const after = await claimableGraphWork({});
  assert.ok(
    !after.some(item => item.taskId === agent.taskId),
    "a finished graph was still being offered to workers"
  );

  const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
  assert.equal(view.graph.status, "succeeded");
});

test("the coordinator expands the graph, workers execute it, and the task completes", async () => {
  // The deployment shape this whole phase is for: the process that decides what
  // the graph should become does not run any of it.
  const previous = process.env.RAZEKIT_JEV_INLINE_EXECUTION;
  process.env.RAZEKIT_JEV_INLINE_EXECUTION = "false";

  try {
    seq += 1;
    const tenantId = "tenant-split-" + seq;
    await ensureTenant(tenantId);
    const now = new Date().toISOString();
    const task = {
      id: id("task"),
      tenantId,
      userId: "split-user",
      taskType: "website",
      title: "Split " + seq,
      originalRequest: "Build a page",
      specification: "Build a page",
      requestedTools: ["filesystem"],
      estimatedBudget: 1,
      maxBudget: 20,
      actualSpend: 0,
      currency: "USD",
      status: TASK_STATUS.READY_FOR_AGENT,
      agentType: AGENT_TYPES.NIOMI,
      agentInstanceId: null,
      authorization: {
        autonomousExecution: true,
        scopes: ["autonomous task execution"],
        toolScopes: [],
        authorizedAt: now
      },
      createdAt: now,
      updatedAt: now
    };
    await transact(db => {
      db.tasks.push(task);
      db.acceptanceCriteria.push({ id: id("ac"), taskId: task.id, text: "The page exists", status: "pending" });
    });
    const agent = await spawnAgentForTask(task.id);
    await startAgent(agent.id);

    const registry = new ModelAdapterRegistry();
    registry.register("astra", {
      async generate(request) {
        if (request.role === "planner") {
          return { output: "planned", architecture: { summary: "one page", steps: [] }, usage: { cost: 0.01 } };
        }
        return { output: "reviewed", review: { decision: "pass", reason: "fine", findings: [] }, usage: { cost: 0.01 } };
      }
    });
    registry.register("fable", {
      async generate() {
        return {
          output: "implemented",
          implementation: { status: "implemented", filesChanged: 1 },
          plan: {
            id: "split-plan",
            version: 1,
            steps: [{ id: "write-index", kind: "workspace_write_file", path: "index.html", content: "<main>ok</main>" }]
          },
          usage: { cost: 0.02 }
        };
      }
    });
    const orchestrator = new ModelOrchestrator({ registry });

    const coordinatorStages = [];
    const workerNodes = [];
    let settled = null;

    // Interleaved the way two processes would be: the coordinator ticks, the
    // worker polls, neither waits for the other.
    for (let i = 0; i < 40 && !settled; i += 1) {
      const result = await advanceAgent(agent.id, { orchestrator });
      coordinatorStages.push(result.stage);
      if ([LOOP_STAGE.COMPLETED, LOOP_STAGE.BLOCKED].includes(result.stage)) {
        settled = result;
        break;
      }

      const ran = await runWorkerOnce({ workerId: "split-worker", modelRegistry: registry });
      if (ran) workerNodes.push({ key: ran.node.key, status: ran.status, worker: ran.node.leaseOwner });
    }

    assert.ok(settled, "neither process settled the task; stages: " + coordinatorStages.join(" -> "));
    assert.equal(settled.stage, LOOP_STAGE.COMPLETED, "stages: " + coordinatorStages.join(" -> "));

    // Every node was executed by the worker, not by the coordinator.
    assert.ok(workerNodes.length >= 4, JSON.stringify(workerNodes));
    const db = await loadDb();
    const graph = db.taskGraphs.find(g => g.taskId === task.id);
    const nodes = db.graphNodes.filter(n => n.graphId === graph.id);
    assert.ok(
      nodes.every(n => n.leaseOwner === "split-worker"),
      "a node was run by the coordinator: " + JSON.stringify(nodes.map(n => n.key + "=" + n.leaseOwner))
    );
  } finally {
    if (previous === undefined) delete process.env.RAZEKIT_JEV_INLINE_EXECUTION;
    else process.env.RAZEKIT_JEV_INLINE_EXECUTION = previous;
  }
});
