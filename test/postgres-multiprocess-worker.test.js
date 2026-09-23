import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Two worker PROCESSES, one database, one of them killed mid-node.
//
// Everything else in this repository proves the pieces: the claim is atomic,
// the lease fences, the sweep recovers. All of it in one process, where the
// JSON store's promise chain quietly serialises everything and a "dead worker"
// is a lease timestamp moved into the past.
//
// This is the real thing. Two operating-system processes, a real Neon
// connection each, and a real SIGKILL. The question it answers is not "does the
// lease work" but "can two workers share a database without the work being done
// twice, the money being counted twice, or the task being lost".
//
// Slow by nature: every claim is an advisory-locked round trip to Neon. It is
// skipped without RAZEKIT_DATABASE_URL, because a test that silently passes on
// a store that cannot exhibit the property is worse than no test.

const DATABASE_URL = process.env.RAZEKIT_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "..", "src", "jev-worker.js");

if (!DATABASE_URL) {
  test("multi-process worker recovery", { skip: "RAZEKIT_DATABASE_URL is not set" }, () => {});
}

const suite = DATABASE_URL ? test : test.skip;

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-mpw-ws-"));
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
if (DATABASE_URL) process.env.RAZEKIT_STORE = "postgres";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { createTaskGraph, graphForTask } = await import("../src/jev.js");

test.after(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

function startWorker(workerId, { leaseMs = 6000, pollMs = 700 } = {}) {
  const child = spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      RAZEKIT_STORE: "postgres",
      RAZEKIT_DATABASE_URL: DATABASE_URL,
      RAZEKIT_WORKSPACE_ROOT: workspaceDir,
      RAZEKIT_JEV_WORKER_ID: workerId,
      RAZEKIT_JEV_WORKER_LEASE_MS: String(leaseMs),
      RAZEKIT_JEV_WORKER_POLL_MS: String(pollMs)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  return { child, output };
}

function stop(worker) {
  if (!worker?.child || worker.child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    worker.child.on("exit", resolve);
    worker.child.kill("SIGKILL");
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let seq = 0;
async function makeTask(nodes) {
  seq += 1;
  const tenantId = "tenant-mpw-" + Date.now() + "-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "mpw-user",
    taskType: "website",
    title: "Multi-process " + seq,
    originalRequest: "Build it",
    specification: "Build it",
    requestedTools: ["filesystem"],
    estimatedBudget: 1,
    maxBudget: 50,
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
    tenantId, userId: task.userId, taskId: task.id, agentInstanceId: agent.id, nodes
  });
  return { task, agent, tenantId, created };
}

/** A node that takes long enough to be killed in the middle of. */
function slowCommandNode(key, seconds, extra = {}) {
  return {
    key,
    kind: "command",
    description: "work that takes " + seconds + "s",
    dependsOn: [],
    payload: {
      id: key,
      kind: "command",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), " + (seconds * 1000) + ")"],
      timeoutMs: 60_000
    },
    maxAttempts: 3,
    toolScopes: [],
    ...extra
  };
}

async function waitFor(check, { timeoutMs = 120_000, everyMs = 1500, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(everyMs);
  }
  throw new Error("timed out waiting for " + what);
}

suite("a killed worker's node is completed by another process, once", { timeout: 300_000 }, async () => {
  const { agent, tenantId } = await makeTask([slowCommandNode("slow-work", 8, { budgetMinor: 250 })]);

  const workerA = startWorker("mpw-a", { leaseMs: 6000 });
  let workerB = null;

  try {
    // Wait for A to actually own it. Not a sleep: the claim is what matters.
    const claimed = await waitFor(async () => {
      const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
      const node = view.nodes.find(item => item.key === "slow-work");
      return node.status === "running" && node.leaseOwner === "mpw-a" ? node : null;
    }, { what: "worker A to claim the node" });

    assert.equal(Number(claimed.attempt), 1);

    // SIGKILL: no shutdown hook, no lease release, no settlement. Exactly what
    // an instance being terminated looks like.
    await stop(workerA);

    workerB = startWorker("mpw-b", { leaseMs: 6000 });

    const finished = await waitFor(async () => {
      const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
      const node = view.nodes.find(item => item.key === "slow-work");
      return node.status === "succeeded" ? node : null;
    }, { timeoutMs: 180_000, what: "worker B to finish the recovered node" });

    // The other process picked it up, and it is recorded as a second attempt
    // rather than disguised as a first.
    assert.equal(finished.leaseOwner, "mpw-b", "the node was not completed by the second process");
    assert.equal(Number(finished.attempt), 2);

    const db = await loadDb();

    // The money: one hold per attempt, none left open, and the work billed once.
    const reservations = db.billingReservations.filter(item => item.agentInstanceId === agent.id);
    assert.equal(
      reservations.filter(item => item.status === "reserved").length, 0,
      "the killed process left budget held"
    );
    assert.equal(
      reservations.filter(item => item.status === "captured").length, 1,
      "the recovered node was captured more than once"
    );

    const ledger = db.billingLedger.filter(item => item.agentInstanceId === agent.id);
    assert.ok(ledger.length <= 1, "the same work was billed " + ledger.length + " times");

    const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
    assert.equal(view.graph.status, "succeeded");
  } finally {
    await stop(workerA);
    await stop(workerB);
  }
});

suite("two live workers never own the same node", { timeout: 300_000 }, async () => {
  const nodes = [
    slowCommandNode("a", 3),
    slowCommandNode("b", 3),
    slowCommandNode("c", 3),
    slowCommandNode("d", 3)
  ];
  const { agent, tenantId } = await makeTask(nodes);

  const workerA = startWorker("pair-a", { leaseMs: 15_000, pollMs: 400 });
  const workerB = startWorker("pair-b", { leaseMs: 15_000, pollMs: 400 });

  try {
    await waitFor(async () => {
      const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });
      return view.graph.status === "succeeded" ? view : null;
    }, { timeoutMs: 240_000, what: "both workers to drain the graph" });

    const view = await graphForTask({ taskId: agent.taskId, tenantId, includeFinished: true });

    // Every node ran exactly once. An attempt above one would mean a claim was
    // handed out twice and the second owner had to redo the work.
    for (const node of view.nodes) {
      assert.equal(node.status, "succeeded", node.key + " did not succeed");
      assert.equal(Number(node.attempt), 1, node.key + " ran " + node.attempt + " times");
    }

    // Both processes did some of it — otherwise this proves nothing about two
    // workers, only that one worker works.
    const owners = new Set(view.nodes.map(node => node.leaseOwner));
    assert.equal(owners.size, 2, "only " + [...owners].join(", ") + " took work");
  } finally {
    await stop(workerA);
    await stop(workerB);
  }
});
