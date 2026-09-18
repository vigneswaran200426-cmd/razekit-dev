import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-worker-agent-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-worker-agent-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { describeHost, detectCapabilities } = await import("../src/worker-agent.js");
const {
  registerWorkerPool,
  registerProductionWorker,
  claimProductionJob,
  createProductionJob,
  heartbeatProductionWorker,
  listProductionWorkers
} = await import("../src/production-runtime.js");
const { transact, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask } = await import("../src/agent-manager.js");

/** A real task and agent, so a job has a real owner to be scoped to. */
async function makeAgent(tenantId) {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: tenantId + "-user",
    tenantId,
    taskType: "website",
    title: "Build for " + tenantId,
    originalRequest: "Build something",
    specification: "Build something",
    requestedTools: ["filesystem"],
    estimatedBudget: 1,
    maxBudget: 10,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: { autonomousExecution: true, scopes: [], authorizedAt: now },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => { db.tasks.push(task); });
  return spawnAgentForTask(task.id);
}

test("a worker reports capacity it can actually be measured against", () => {
  const host = describeHost();

  assert.ok(host.cpuCount > 0, "a worker must report its vCPU count");
  assert.ok(host.totalMemoryBytes > 0, "a worker must report its memory");
  assert.ok(host.platform && host.arch);

  // No address, instance id or account identifier. The control plane schedules
  // by capacity, and recording the rest would make the worker table an
  // inventory of the operator's infrastructure.
  const serialised = JSON.stringify(host);
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(serialised), "a worker must not report an IP address");
  for (const key of ["ip", "publicIp", "privateIp", "instanceId", "accountId", "hostname"]) {
    assert.ok(!(key in host), `a worker must not report ${key}`);
  }
});

test("capabilities are declared, never assumed", () => {
  const previous = process.env.RAZEKIT_WORKER_CAPABILITIES;

  delete process.env.RAZEKIT_WORKER_CAPABILITIES;
  const defaults = detectCapabilities();
  assert.deepEqual(defaults, ["node", "npm", "git"]);
  // Claiming a game engine that is not installed means accepting game builds
  // that cannot run, so an engine is never in the default set.
  assert.ok(!defaults.includes("unity"));
  assert.ok(!defaults.includes("unreal"));

  process.env.RAZEKIT_WORKER_CAPABILITIES = "node, npm, git, unity";
  assert.deepEqual(detectCapabilities(), ["node", "npm", "git", "unity"]);

  if (previous === undefined) delete process.env.RAZEKIT_WORKER_CAPABILITIES;
  else process.env.RAZEKIT_WORKER_CAPABILITIES = previous;
});

test("one pool serves many isolated task runtimes, not one box per user", async () => {
  const pool = await registerWorkerPool({
    name: "cpu-shared",
    resourceClass: "cpu",
    runtime: "container",
    capacity: 3
  });

  // A single machine registering once, offering capacity for several
  // concurrent task runtimes.
  for (const id of ["host-a-1", "host-a-2", "host-a-3"]) {
    await registerProductionWorker({
      poolId: pool.id,
      workerId: id,
      runtime: "container",
      resourceClass: "cpu",
      capabilities: ["node", "npm", "git"],
      metadata: describeHost()
    });
  }

  // Three different tenants' work, queued against one shared pool.
  for (const tenant of ["tenant-one", "tenant-two", "tenant-three"]) {
    const agent = await makeAgent(tenant);
    await createProductionJob({
      agentInstanceId: agent.id,
      kind: "app_web_execution",
      resourceClass: "cpu",
      idempotencyKey: "shared-" + tenant
    });
  }

  const claims = [
    await claimProductionJob(pool.id, "host-a-1"),
    await claimProductionJob(pool.id, "host-a-2"),
    await claimProductionJob(pool.id, "host-a-3")
  ];

  assert.ok(claims.every(Boolean), "each runtime should claim its own job");
  const jobIds = new Set(claims.map(c => c.job.id));
  assert.equal(jobIds.size, 3, "two runtimes must never claim the same job");

  // Capacity exhausted: the fourth waits in the queue rather than being
  // squeezed onto a machine that is already full.
  const overflow = await makeAgent("tenant-four");
  await createProductionJob({
    agentInstanceId: overflow.id,
    kind: "app_web_execution",
    resourceClass: "cpu",
    idempotencyKey: "shared-overflow"
  });
  assert.equal(await claimProductionJob(pool.id, "host-a-1"), null);
});

test("a stale worker stops being given work without any cooperation from it", async () => {
  const pool = await registerWorkerPool({
    name: "cpu-stale",
    resourceClass: "cpu",
    runtime: "container",
    capacity: 2
  });

  await registerProductionWorker({
    poolId: pool.id,
    workerId: "host-gone",
    runtime: "container",
    resourceClass: "cpu",
    capabilities: ["node"],
    metadata: describeHost()
  });

  const agent = await makeAgent("tenant-stale");
  await createProductionJob({
    agentInstanceId: agent.id,
    kind: "app_web_execution",
    resourceClass: "cpu",
    idempotencyKey: "stale-job-1"
  });

  // The machine vanishes — a terminated instance, a partition. It cannot tell
  // anyone, so the absence of a heartbeat has to be enough.
  await transact(db => {
    const worker = db.productionWorkers.find(item => item.workerId === "host-gone");
    worker.heartbeatAt = new Date(Date.now() - 10 * 60_000).toISOString();
  });

  assert.equal(await claimProductionJob(pool.id, "host-gone"), null, "a stale worker must not receive work");

  const offline = (await listProductionWorkers(pool.id)).find(w => w.workerId === "host-gone");
  assert.equal(offline.status, "offline");

  // And it cannot quietly resume by heartbeating again from the dead.
  await assert.rejects(() => heartbeatProductionWorker("host-gone", {}), /not accepting heartbeats/);
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
