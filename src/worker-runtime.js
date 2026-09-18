import { randomUUID } from "node:crypto";
import { loadDb, transact } from "./store.js";
import { WORKER_STATUS } from "./domain.js";
import { WORKER_RUNTIME_STATE } from "./runtime-domain.js";

const DEFAULT_LEASE_MS = Number(process.env.RAZEKIT_WORKER_LEASE_MS || 60000);

export async function leaseWorker(workerId, ownerId, leaseMs = DEFAULT_LEASE_MS) {
  if (!ownerId?.trim()) throw new Error("Worker lease owner is required");

  return transact(db => {
    const worker = db.workers.find(x => x.id === workerId);
    if (!worker) throw new Error("Worker not found");

    const now = Date.now();
    const existingExpiry = worker.leaseExpiresAt ? Date.parse(worker.leaseExpiresAt) : 0;
    if (worker.leaseId && existingExpiry > now && worker.leaseOwner !== ownerId) {
      throw new Error("Worker is already leased");
    }

    const leaseId = randomUUID();
    worker.leaseId = leaseId;
    worker.leaseOwner = ownerId;
    worker.leaseExpiresAt = new Date(now + Math.max(1000, leaseMs)).toISOString();
    worker.runtimeState = WORKER_RUNTIME_STATE.LEASED;
    worker.status = WORKER_STATUS.RUNNING;
    worker.heartbeatAt = new Date(now).toISOString();

    return {
      workerId,
      leaseId,
      ownerId,
      expiresAt: worker.leaseExpiresAt
    };
  });
}

export async function renewWorkerLease(workerId, leaseId, leaseMs = DEFAULT_LEASE_MS) {
  return transact(db => {
    const worker = db.workers.find(x => x.id === workerId);
    if (!worker) throw new Error("Worker not found");
    if (worker.leaseId !== leaseId) throw new Error("Invalid worker lease");

    const now = Date.now();
    worker.leaseExpiresAt = new Date(now + Math.max(1000, leaseMs)).toISOString();
    worker.heartbeatAt = new Date(now).toISOString();
    worker.runtimeState = WORKER_RUNTIME_STATE.RUNNING;

    return {
      workerId,
      leaseId,
      expiresAt: worker.leaseExpiresAt,
      heartbeatAt: worker.heartbeatAt
    };
  });
}

export async function releaseWorkerLease(workerId, leaseId, finalState = WORKER_RUNTIME_STATE.READY) {
  return transact(db => {
    const worker = db.workers.find(x => x.id === workerId);
    if (!worker) throw new Error("Worker not found");
    if (worker.leaseId !== leaseId) throw new Error("Invalid worker lease");

    worker.leaseId = null;
    worker.leaseOwner = null;
    worker.leaseExpiresAt = null;
    worker.runtimeState = finalState;
    worker.heartbeatAt = new Date().toISOString();

    return worker;
  });
}

export async function checkpointWorker(workerId, leaseId, checkpoint) {
  if (checkpoint == null || typeof checkpoint !== "object") {
    throw new Error("Checkpoint must be an object");
  }

  return transact(db => {
    const worker = db.workers.find(x => x.id === workerId);
    if (!worker) throw new Error("Worker not found");
    if (worker.leaseId !== leaseId) throw new Error("Invalid worker lease");

    worker.checkpoint = checkpoint;
    worker.checkpointAt = new Date().toISOString();
    worker.heartbeatAt = worker.checkpointAt;

    return {
      workerId,
      checkpointAt: worker.checkpointAt,
      checkpoint
    };
  });
}

export async function getWorkerRuntime(workerId) {
  const db = await loadDb();
  const worker = db.workers.find(x => x.id === workerId);
  if (!worker) return null;

  const now = Date.now();
  const expired = !!worker.leaseExpiresAt && Date.parse(worker.leaseExpiresAt) <= now;

  if (expired && worker.leaseId) {
    return {
      ...worker,
      leaseExpired: true
    };
  }

  return {
    ...worker,
    leaseExpired: false
  };
}

export async function recoverExpiredWorkerLease(workerId) {
  return transact(db => {
    const worker = db.workers.find(x => x.id === workerId);
    if (!worker) throw new Error("Worker not found");

    if (!worker.leaseId || !worker.leaseExpiresAt || Date.parse(worker.leaseExpiresAt) > Date.now()) {
      return worker;
    }

    worker.leaseId = null;
    worker.leaseOwner = null;
    worker.leaseExpiresAt = null;
    worker.runtimeState = WORKER_RUNTIME_STATE.READY;
    worker.status = WORKER_STATUS.READY;
    worker.heartbeatAt = new Date().toISOString();

    return worker;
  });
}
