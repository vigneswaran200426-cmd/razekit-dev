import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-prod-data-"));
const objectDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-prod-objects-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-prod-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_OBJECT_ROOT = objectDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { id, loadDb, transact } = await import("../src/store.js");
const { TASK_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const {
  JOB_STATUS,
  createJob
} = await import("../src/reliability.js");
const {
  WORKER_RESOURCE_CLASS,
  RUNTIME_KIND,
  registerWorkerPool,
  registerProductionWorker,
  claimProductionJob,
  completeProductionJob,
  createProductionJob,
  listWorkerPools,
  listProductionWorkers
} = await import("../src/production-runtime.js");
const {
  buildContainerSpec,
  buildMicroVMRuntimeSpec,
  buildGpuWorkerSpec
} = await import("../src/production-runtimes.js");
const { createNetworkPolicy, assertNetworkAccess } = await import("../src/network-policy.js");
const { LocalPersistentObjectStore, persistArtifact } = await import("../src/object-storage.js");
const {
  recordObservabilityEvent,
  recordMetric,
  evaluateInfrastructureAlerts,
  resolveAlert,
  listAlerts,
  metricsSnapshot
} = await import("../src/observability.js");

async function makeTask(title = "Production infrastructure task") {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId: "infra-tenant",
    userId: "infra-user",
    taskType: "website",
    title,
    originalRequest: "Build a production test app",
    specification: "Build a production test app",
    requestedTools: ["filesystem"],
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

  await transact(db => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({
      id: id("ac"),
      taskId: task.id,
      text: "Infrastructure acceptance",
      status: "pending"
    });
  });

  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent };
}

test("production worker pools enforce resource contracts and capacity", async () => {
  const pool = await registerWorkerPool({
    name: "cpu-main",
    resourceClass: WORKER_RESOURCE_CLASS.CPU,
    runtime: RUNTIME_KIND.CONTAINER,
    capacity: 1
  });

  const firstWorker = await registerProductionWorker({
    poolId: pool.id,
    workerId: "cpu-worker-1",
    resourceClass: WORKER_RESOURCE_CLASS.CPU,
    runtime: RUNTIME_KIND.CONTAINER,
    capabilities: ["node"]
  });
  const secondWorker = await registerProductionWorker({
    poolId: pool.id,
    workerId: "cpu-worker-2",
    resourceClass: WORKER_RESOURCE_CLASS.CPU,
    runtime: RUNTIME_KIND.CONTAINER,
    capabilities: ["node"]
  });

  assert.equal(firstWorker.status, "ready");
  assert.equal(secondWorker.status, "ready");

  const { agent } = await makeTask();
  const job = await createProductionJob({
    agentInstanceId: agent.id,
    kind: "build",
    resourceClass: WORKER_RESOURCE_CLASS.CPU,
    payload: { project: "demo" },
    idempotencyKey: "prod-build-1"
  });

  const claimed = await claimProductionJob(pool.id, "cpu-worker-1");
  assert.equal(claimed.job.id, job.id);
  assert.equal(claimed.worker.workerId, "cpu-worker-1");

  const blocked = await claimProductionJob(pool.id, "cpu-worker-2");
  assert.equal(blocked, null);

  const completed = await completeProductionJob("cpu-worker-1", { ok: true });
  assert.equal(completed.status, JOB_STATUS.COMPLETED);

  const workers = await listProductionWorkers(pool.id);
  assert.equal(workers.find(item => item.workerId === "cpu-worker-1").status, "ready");
  assert.equal((await listWorkerPools())[0].activeWorkers, 0);
});

test("resource-class routing prevents CPU workers from claiming GPU jobs", async () => {
  const cpuPool = await registerWorkerPool({
    name: "cpu-routing",
    resourceClass: WORKER_RESOURCE_CLASS.CPU,
    runtime: RUNTIME_KIND.CONTAINER,
    capacity: 2
  });
  const gpuPool = await registerWorkerPool({
    name: "gpu-routing",
    resourceClass: WORKER_RESOURCE_CLASS.GPU,
    runtime: RUNTIME_KIND.CONTAINER,
    capacity: 1
  });

  await registerProductionWorker({
    poolId: cpuPool.id,
    workerId: "cpu-routing-worker",
    resourceClass: WORKER_RESOURCE_CLASS.CPU,
    runtime: RUNTIME_KIND.CONTAINER
  });
  await registerProductionWorker({
    poolId: gpuPool.id,
    workerId: "gpu-routing-worker",
    resourceClass: WORKER_RESOURCE_CLASS.GPU,
    runtime: RUNTIME_KIND.CONTAINER,
    capabilities: ["cuda"]
  });

  const { agent } = await makeTask("GPU route");
  await createProductionJob({
    agentInstanceId: agent.id,
    kind: "game-build",
    resourceClass: WORKER_RESOURCE_CLASS.GPU,
    idempotencyKey: "gpu-job-1"
  });

  assert.equal(await claimProductionJob(cpuPool.id, "cpu-routing-worker"), null);
  const claimed = await claimProductionJob(gpuPool.id, "gpu-routing-worker");
  assert.equal(claimed.job.resourceClass, WORKER_RESOURCE_CLASS.GPU);
  await completeProductionJob("gpu-routing-worker");
});

test("production runtime specs fail closed on unsafe container configuration", () => {
  assert.throws(
    () => buildContainerSpec({
      image: "razekit/app:latest",
      workspacePath: "/workspace",
      networkPolicyId: "netpol-1",
      privileged: true
    }),
    /Privileged containers are not permitted/
  );

  assert.throws(
    () => buildContainerSpec({
      image: "razekit/app:latest",
      workspacePath: "/workspace",
      networkPolicyId: "netpol-1",
      environment: { API_TOKEN: "secret" }
    }),
    /Secrets must not be embedded/
  );

  const container = buildContainerSpec({
    image: "razekit/app:latest",
    workspacePath: "/workspace",
    networkPolicyId: "netpol-1"
  });
  assert.equal(container.security.dropAllCapabilities, true);
  assert.equal(container.security.noNewPrivileges, true);

  const vm = buildMicroVMRuntimeSpec({
    image: "razekit/game:latest",
    kernel: "vmlinux",
    rootDisk: "rootfs.ext4",
    workspaceDisk: "workspace.ext4",
    networkPolicyId: "netpol-2",
    vcpus: 4,
    memoryMiB: 8192
  });
  assert.equal(vm.runtime, "microvm");

  const gpu = buildGpuWorkerSpec({ vendor: "nvidia", deviceCount: 1 });
  assert.equal(gpu.resourceClass, "gpu");
});

test("network policy defaults to deny and blocks local/private targets", async () => {
  const policy = await createNetworkPolicy({
    name: "public-only",
    tenantId: "infra-tenant",
    defaultAction: "deny",
    allowedHosts: ["example.com"],
    allowedPorts: [443]
  });

  assert.deepEqual(
    assertNetworkAccess(policy, "https://example.com"),
    { allowed: true, protocol: "https:", hostname: "example.com", port: 443 }
  );

  assert.throws(
    () => assertNetworkAccess(policy, "https://google.com"),
    /not allowed/
  );
  assert.throws(
    () => assertNetworkAccess(policy, "https://127.0.0.1"),
    /not allowed/
  );
  assert.throws(
    () => assertNetworkAccess(policy, "https://example.com:8443"),
    /port is not allowed/
  );
});

test("artifacts are persisted under tenant namespace", async () => {
  const store = new LocalPersistentObjectStore(objectDir);
  const result = await persistArtifact({
    store,
    tenantId: "tenant-x",
    taskId: "task-x",
    artifactType: "build",
    objectKey: "build/app.zip",
    value: "artifact-bytes"
  });

  assert.equal(result.objectKey, "tenant-x/build/app.zip");
  const fetched = await store.get(result.objectKey);
  assert.equal(fetched.data.toString(), "artifact-bytes");
  assert.equal(fetched.metadata.tenantId, "tenant-x");
  assert.equal(fetched.metadata.taskId, "task-x");
});

test("observability records metrics and opens/resolves stale worker alerts", async () => {
  await recordObservabilityEvent({
    tenantId: "infra-tenant",
    type: "worker.test",
    severity: "info",
    message: "Worker registered"
  });
  await recordMetric({ name: "test_latency", value: 12, unit: "ms", tags: { source: "ci" } });

  const db = await loadDb();
  const now = new Date(Date.now() - 300_000).toISOString();
  await transact(state => {
    state.productionWorkers.push({
      id: id("pworker"),
      workerId: "stale-worker",
      poolId: "none",
      runtime: "container",
      resourceClass: "cpu",
      capabilities: [],
      status: "busy",
      heartbeatAt: now,
      activeJobId: "job-stale",
      runtimeId: null,
      metadata: {},
      createdAt: now,
      updatedAt: now
    });
  });

  const alerts = await evaluateInfrastructureAlerts({ workerStaleMs: 120_000 });
  assert.ok(alerts.some(alert => alert.key === "worker_heartbeat"));

  const open = await listAlerts({ status: "open" });
  assert.ok(open.length > 0);
  await resolveAlert(open[0].id);
  assert.equal((await listAlerts({ status: "open" })).length, open.length - 1);

  const snapshot = await metricsSnapshot();
  assert.ok(snapshot.productionWorkers >= 1);
  assert.ok(snapshot.openAlerts >= 0);
});

test("store migration defaults legacy jobs to CPU", async () => {
  await transact(db => {
    db.jobs.push({
      id: id("job"),
      taskId: "legacy-task",
      agentInstanceId: "legacy-agent",
      kind: "legacy",
      status: "queued",
      attempts: 0,
      maxAttempts: 1,
      availableAt: new Date().toISOString(),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      result: null,
      idempotencyKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null
    });
  });

  const db = await loadDb();
  assert.equal(db.jobs.find(item => item.kind === "legacy").resourceClass, "cpu");
  assert.equal(db.schemaVersion, 5);
  assert.ok(db.migrationsApplied.includes("phase-12-production-infrastructure"));
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(objectDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
