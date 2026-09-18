import { randomUUID } from "node:crypto";
import { id, loadDb, transact } from "./store.js";
import { JOB_STATUS, claimNextJob, completeJob, retryJob, blockJob, createJob } from "./reliability.js";

export const WORKER_RESOURCE_CLASS = {
  CPU: "cpu",
  GPU: "gpu"
};

export const RUNTIME_KIND = {
  CONTAINER: "container",
  MICROVM: "microvm",
  LOCAL: "local"
};

const RESOURCE_CLASSES = new Set(Object.values(WORKER_RESOURCE_CLASS));
const RUNTIMES = new Set(Object.values(RUNTIME_KIND));

export function assertResourceClass(value) {
  if (!RESOURCE_CLASSES.has(value)) throw new Error("Unsupported worker resource class: " + value);
}

export function assertRuntimeKind(value) {
  if (!RUNTIMES.has(value)) throw new Error("Unsupported worker runtime: " + value);
}

export class ProductionRuntimeAdapter {
  async provision() {
    throw new Error("ProductionRuntimeAdapter.provision() is not implemented");
  }

  async execute() {
    throw new Error("ProductionRuntimeAdapter.execute() is not implemented");
  }

  async terminate() {
    throw new Error("ProductionRuntimeAdapter.terminate() is not implemented");
  }
}

export class DeterministicProductionRuntimeAdapter extends ProductionRuntimeAdapter {
  async provision(spec) {
    return {
      runtimeId: "runtime_" + randomUUID(),
      runtime: spec.runtime,
      resourceClass: spec.resourceClass,
      status: "ready"
    };
  }

  async execute(spec, job) {
    return {
      runtimeId: spec.runtimeId,
      jobId: job.id,
      status: "completed"
    };
  }

  async terminate(spec) {
    return { runtimeId: spec.runtimeId, status: "terminated" };
  }
}

export class RuntimeAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(runtime, adapter) {
    assertRuntimeKind(runtime);
    if (!adapter || typeof adapter.provision !== "function" || typeof adapter.execute !== "function") {
      throw new Error("Production runtime adapter is invalid");
    }
    this.adapters.set(runtime, adapter);
  }

  get(runtime) {
    const adapter = this.adapters.get(runtime);
    if (!adapter) throw new Error("No production runtime adapter configured for: " + runtime);
    return adapter;
  }
}

export async function registerWorkerPool({
  name,
  resourceClass = WORKER_RESOURCE_CLASS.CPU,
  runtime = RUNTIME_KIND.CONTAINER,
  capacity = 1,
  metadata = {}
}) {
  if (!name?.trim()) throw new Error("Worker pool name is required");
  assertResourceClass(resourceClass);
  assertRuntimeKind(runtime);
  const normalizedCapacity = Math.floor(Number(capacity));
  if (!Number.isFinite(normalizedCapacity) || normalizedCapacity < 1) {
    throw new Error("Worker pool capacity must be at least 1");
  }

  return transact(db => {
    const existing = db.workerPools.find(item => item.name === name);
    if (existing) {
      existing.resourceClass = resourceClass;
      existing.runtime = runtime;
      existing.capacity = normalizedCapacity;
      existing.metadata = metadata;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }

    const now = new Date().toISOString();
    const pool = {
      id: id("pool"),
      name,
      resourceClass,
      runtime,
      capacity: normalizedCapacity,
      activeWorkers: 0,
      healthyWorkers: 0,
      status: "active",
      metadata,
      createdAt: now,
      updatedAt: now
    };
    db.workerPools.push(pool);
    return pool;
  });
}

export async function registerProductionWorker({
  poolId,
  workerId,
  runtime,
  resourceClass,
  capabilities = [],
  metadata = {}
}) {
  assertRuntimeKind(runtime);
  assertResourceClass(resourceClass);
  return transact(db => {
    const pool = db.workerPools.find(item => item.id === poolId);
    if (!pool) throw new Error("Worker pool not found");
    if (pool.resourceClass !== resourceClass || pool.runtime !== runtime) {
      throw new Error("Worker does not match pool resource contract");
    }

    const existing = db.productionWorkers.find(item => item.workerId === workerId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const worker = {
      id: id("pworker"),
      workerId,
      poolId,
      runtime,
      resourceClass,
      capabilities: [...new Set(capabilities)],
      status: "ready",
      heartbeatAt: now,
      activeJobId: null,
      runtimeId: null,
      metadata,
      createdAt: now,
      updatedAt: now
    };
    db.productionWorkers.push(worker);
    pool.healthyWorkers += 1;
    pool.updatedAt = now;
    return worker;
  });
}

export async function heartbeatProductionWorker(workerId, metadata = {}) {
  return transact(db => {
    const worker = db.productionWorkers.find(item => item.workerId === workerId);
    if (!worker) throw new Error("Production worker not found");
    if (worker.status === "draining" || worker.status === "offline") {
      throw new Error("Production worker is not accepting heartbeats in status " + worker.status);
    }
    worker.heartbeatAt = new Date().toISOString();
    worker.metadata = { ...worker.metadata, ...metadata };
    worker.updatedAt = worker.heartbeatAt;
    return worker;
  });
}

export async function claimProductionJob(poolId, ownerId, leaseMs = 30_000) {
  if (!ownerId?.trim()) throw new Error("Production worker owner is required");
  const lease = Math.max(1000, Number(leaseMs));

  return transact(db => {
    const pool = db.workerPools.find(item => item.id === poolId);
    if (!pool) throw new Error("Worker pool not found");
    if (pool.status !== "active") throw new Error("Worker pool is not active");
    if (pool.activeWorkers >= pool.capacity) return null;

    const worker = db.productionWorkers.find(item =>
      item.poolId === poolId &&
      item.status === "ready" &&
      !item.activeJobId
    );
    if (!worker) return null;

    const now = Date.now();
    const availableJob = db.jobs
      .filter(job =>
        [JOB_STATUS.QUEUED, JOB_STATUS.RETRYING].includes(job.status) &&
        job.resourceClass === pool.resourceClass &&
        Date.parse(job.availableAt) <= now
      )
      .sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt))[0];

    if (!availableJob) return null;

    availableJob.status = JOB_STATUS.RUNNING;
    availableJob.attempts += 1;
    availableJob.leaseId = randomUUID();
    availableJob.leaseOwner = ownerId;
    availableJob.leaseExpiresAt = new Date(now + lease).toISOString();
    availableJob.updatedAt = new Date(now).toISOString();

    worker.status = "busy";
    worker.activeJobId = availableJob.id;
    worker.updatedAt = new Date(now).toISOString();

    pool.activeWorkers += 1;
    pool.updatedAt = worker.updatedAt;

    return { job: availableJob, worker };
  });
}
export async function recoverProductionAssignments() {
  return transact(db => {
    const recovered = [];
    for (const worker of db.productionWorkers) {
      if (worker.status !== "busy" || !worker.activeJobId) continue;
      const job = db.jobs.find(item => item.id === worker.activeJobId);
      if (job && job.status === JOB_STATUS.RUNNING) continue;

      const pool = db.workerPools.find(item => item.id === worker.poolId);
      const releasedJobId = worker.activeJobId;
      worker.status = "ready";
      worker.activeJobId = null;
      worker.updatedAt = new Date().toISOString();
      if (pool) {
        pool.activeWorkers = Math.max(0, pool.activeWorkers - 1);
        pool.updatedAt = worker.updatedAt;
      }
      recovered.push({ workerId: worker.workerId, jobId: releasedJobId });
    }
    return recovered;
  });
}

export async function completeProductionJob(workerId, result = null) {
  const db = await loadDb();
  const worker = db.productionWorkers.find(item => item.workerId === workerId);
  if (!worker) throw new Error("Production worker not found");
  if (!worker.activeJobId) throw new Error("Worker has no active job");

  const job = db.jobs.find(item => item.id === worker.activeJobId);
  if (!job) throw new Error("Production job not found");
  const completed = await completeJob(job.id, job.leaseId, result);

  await transact(state => releaseWorkerCapacity(state, workerId, completed.id, "ready"));
  return completed;
}

export async function retryProductionJob(workerId, errorMessage, delayMs = 1000) {
  const db = await loadDb();
  const worker = db.productionWorkers.find(item => item.workerId === workerId);
  if (!worker?.activeJobId) throw new Error("Worker has no active job");
  const job = db.jobs.find(item => item.id === worker.activeJobId);
  if (!job) throw new Error("Production job not found");
  const retried = await retryJob(job.id, job.leaseId, errorMessage, delayMs);

  await transact(state => releaseWorkerCapacity(
    state,
    workerId,
    retried.id,
    retried.status === JOB_STATUS.DEAD_LETTER ? "ready" : "ready"
  ));
  return retried;
}

export async function blockProductionJob(workerId, reason) {
  const db = await loadDb();
  const worker = db.productionWorkers.find(item => item.workerId === workerId);
  if (!worker?.activeJobId) throw new Error("Worker has no active job");
  const job = db.jobs.find(item => item.id === worker.activeJobId);
  if (!job) throw new Error("Production job not found");
  const blocked = await blockJob(job.id, job.leaseId, reason);

  await transact(state => releaseWorkerCapacity(state, workerId, blocked.id, "ready"));
  return blocked;
}

function releaseWorkerCapacity(db, workerId, jobId, status) {
  const worker = db.productionWorkers.find(item => item.workerId === workerId);
  if (!worker) throw new Error("Production worker not found");
  const pool = db.workerPools.find(item => item.id === worker.poolId);

  if (worker.activeJobId !== jobId) throw new Error("Worker/job assignment mismatch");
  worker.activeJobId = null;
  worker.status = status;
  worker.updatedAt = new Date().toISOString();

  if (pool) {
    pool.activeWorkers = Math.max(0, pool.activeWorkers - 1);
    pool.updatedAt = worker.updatedAt;
  }
}

export async function listWorkerPools() {
  const db = await loadDb();
  return db.workerPools;
}

export async function listProductionWorkers(poolId = null) {
  const db = await loadDb();
  return db.productionWorkers.filter(item => !poolId || item.poolId === poolId);
}

export function jobInputForResource(input = {}) {
  assertResourceClass(input.resourceClass || WORKER_RESOURCE_CLASS.CPU);
  return {
    ...input,
    resourceClass: input.resourceClass || WORKER_RESOURCE_CLASS.CPU
  };
}

export async function createProductionJob(input) {
  return createJob(jobInputForResource(input));
}
