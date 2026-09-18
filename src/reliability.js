import { randomUUID } from "node:crypto";
import { id, loadDb, transact } from "./store.js";
import {
  AGENT_STATUS,
  AGENT_TYPES,
  TASK_STATUS,
  WORKER_STATUS,
  agentTypeForTask,
  toolManifestForTask
} from "./domain.js";
import { WORKER_RUNTIME_STATE } from "./runtime-domain.js";
import { startAgent } from "./agent-manager.js";
import { recoverExpiredWorkerLease } from "./worker-runtime.js";

export const JOB_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  RETRYING: "retrying",
  COMPLETED: "completed",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  BLOCKED: "blocked",
  CANCELLED: "cancelled"
};

const DEFAULT_MAX_ATTEMPTS = Number(process.env.RAZEKIT_JOB_MAX_ATTEMPTS || 3);
const DEFAULT_LEASE_MS = Number(process.env.RAZEKIT_JOB_LEASE_MS || 30000);
const DEFAULT_BACKOFF_MS = Number(process.env.RAZEKIT_JOB_BACKOFF_MS || 1000);

function normalizeAttempts(value) {
  return Math.max(1, Math.floor(Number(value || DEFAULT_MAX_ATTEMPTS)));
}

function normalizeDelay(value) {
  return Math.max(0, Math.floor(Number(value || 0)));
}

export async function writeCheckpoint(scope, checkpoint, metadata = {}) {
  if (!scope?.agentInstanceId || !scope?.kind) {
    throw new Error("Checkpoint scope requires agentInstanceId and kind");
  }
  if (checkpoint == null || typeof checkpoint !== "object") {
    throw new Error("Checkpoint must be an object");
  }

  return transact(db => {
    const now = new Date().toISOString();
    const existing = db.stateCheckpoints.find(x =>
      x.agentInstanceId === scope.agentInstanceId &&
      x.kind === scope.kind &&
      x.scopeId === (scope.scopeId || null)
    );

    const item = {
      id: existing?.id || id("chk"),
      agentInstanceId: scope.agentInstanceId,
      taskId: scope.taskId || existing?.taskId || null,
      kind: scope.kind,
      scopeId: scope.scopeId || null,
      version: Number(existing?.version || 0) + 1,
      checkpoint,
      metadata,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    if (existing) Object.assign(existing, item);
    else db.stateCheckpoints.push(item);

    return item;
  });
}

export async function getCheckpoint(agentInstanceId, kind, scopeId = null) {
  const db = await loadDb();
  return db.stateCheckpoints.find(x =>
    x.agentInstanceId === agentInstanceId &&
    x.kind === kind &&
    x.scopeId === scopeId
  ) || null;
}

export async function createJob(input = {}) {
  if (!input.kind?.trim()) throw new Error("Job kind is required");
  if (!input.agentInstanceId?.trim()) throw new Error("Job agentInstanceId is required");

  const maxAttempts = normalizeAttempts(input.maxAttempts);
  const availableAt = input.availableAt
    ? new Date(input.availableAt).toISOString()
    : new Date().toISOString();

  return transact(db => {
    const existing = input.idempotencyKey
      ? db.jobs.find(x =>
          x.agentInstanceId === input.agentInstanceId &&
          x.idempotencyKey === input.idempotencyKey
        )
      : null;
    if (existing) return existing;

    const agent = db.agentInstances.find(x => x.id === input.agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");

    const now = new Date().toISOString();
    const job = {
      id: id("job"),
      taskId: input.taskId || agent.taskId,
      agentInstanceId: input.agentInstanceId,
      kind: input.kind.trim(),
      payload: input.payload ?? {},
      status: JOB_STATUS.QUEUED,
      attempts: 0,
      maxAttempts,
      availableAt,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      result: null,
      idempotencyKey: input.idempotencyKey || null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };

    db.jobs.push(job);
    return job;
  });
}

export async function claimNextJob(ownerId, leaseMs = DEFAULT_LEASE_MS, filters = {}) {
  if (!ownerId?.trim()) throw new Error("Job lease owner is required");
  if (filters.agentInstanceId != null && !filters.agentInstanceId.trim()) {
    throw new Error("agentInstanceId filter must be non-empty");
  }
  if (filters.taskId != null && !filters.taskId.trim()) {
    throw new Error("taskId filter must be non-empty");
  }
  if (filters.kind != null && !filters.kind.trim()) {
    throw new Error("kind filter must be non-empty");
  }

  return transact(db => {
    const now = Date.now();
    const available = db.jobs
      .filter(job =>
        [JOB_STATUS.QUEUED, JOB_STATUS.RETRYING].includes(job.status) &&
        Date.parse(job.availableAt) <= now &&
        (!filters.agentInstanceId || job.agentInstanceId === filters.agentInstanceId) &&
        (!filters.taskId || job.taskId === filters.taskId) &&
        (!filters.kind || job.kind === filters.kind)
      )
      .sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt));

    const job = available[0];
    if (!job) return null;

    job.status = JOB_STATUS.RUNNING;
    job.attempts += 1;
    job.leaseId = randomUUID();
    job.leaseOwner = ownerId;
    job.leaseExpiresAt = new Date(now + Math.max(1000, leaseMs)).toISOString();
    job.updatedAt = new Date(now).toISOString();

    return job;
  });
}

export async function completeJob(jobId, leaseId, result = null) {
  return transact(db => {
    const job = db.jobs.find(x => x.id === jobId);
    if (!job) throw new Error("Job not found");
    assertJobLease(job, leaseId);

    const now = new Date().toISOString();
    job.status = JOB_STATUS.COMPLETED;
    job.result = result;
    job.lastError = null;
    job.leaseId = null;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.completedAt = now;
    job.updatedAt = now;
    return job;
  });
}

export async function retryJob(jobId, leaseId, errorMessage, delayMs = DEFAULT_BACKOFF_MS) {
  return transact(db => {
    const job = db.jobs.find(x => x.id === jobId);
    if (!job) throw new Error("Job not found");
    assertJobLease(job, leaseId);

    const now = Date.now();
    job.lastError = String(errorMessage || "Job failed");
    job.leaseId = null;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;

    if (job.attempts >= job.maxAttempts) {
      job.status = JOB_STATUS.DEAD_LETTER;
      job.completedAt = new Date(now).toISOString();
    } else {
      job.status = JOB_STATUS.RETRYING;
      job.availableAt = new Date(now + normalizeDelay(delayMs) * Math.max(1, job.attempts)).toISOString();
    }

    job.updatedAt = new Date(now).toISOString();
    return job;
  });
}

export async function blockJob(jobId, leaseId, reason) {
  return transact(db => {
    const job = db.jobs.find(x => x.id === jobId);
    if (!job) throw new Error("Job not found");
    assertJobLease(job, leaseId);

    const now = new Date().toISOString();
    job.status = JOB_STATUS.BLOCKED;
    job.lastError = String(reason || "Job blocked");
    job.leaseId = null;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.updatedAt = now;
    return job;
  });
}

export async function recoverExpiredJobs() {
  return transact(db => {
    const now = Date.now();
    const recovered = [];

    for (const job of db.jobs) {
      if (
        job.status === JOB_STATUS.RUNNING &&
        job.leaseExpiresAt &&
        Date.parse(job.leaseExpiresAt) <= now
      ) {
        job.leaseId = null;
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        if (job.attempts >= job.maxAttempts) {
          job.status = JOB_STATUS.DEAD_LETTER;
          job.completedAt = new Date(now).toISOString();
        } else {
          job.status = JOB_STATUS.RETRYING;
          job.availableAt = new Date(now + DEFAULT_BACKOFF_MS * Math.max(1, job.attempts)).toISOString();
        }
        job.lastError = job.lastError || "Job lease expired";
        job.updatedAt = new Date(now).toISOString();
        recovered.push(job.id);
      }
    }

    return recovered;
  });
}

export async function listJobs(agentInstanceId = null) {
  const db = await loadDb();
  return db.jobs.filter(job => !agentInstanceId || job.agentInstanceId === agentInstanceId);
}

export async function runIdempotent(operationName, idempotencyKey, handler) {
  if (!operationName?.trim()) throw new Error("Operation name is required");
  if (!idempotencyKey?.trim()) throw new Error("Idempotency key is required");
  if (typeof handler !== "function") throw new Error("Idempotent operation handler is required");

  const claim = await transact(db => {
    const now = Date.now();
    const existing = db.idempotencyRecords.find(x =>
      x.operationName === operationName &&
      x.idempotencyKey === idempotencyKey
    );

    if (existing?.status === "completed") {
      return { owned: false, result: existing.result };
    }

    if (existing?.status === "processing") {
      const expiresAt = existing.expiresAt ? Date.parse(existing.expiresAt) : 0;
      if (expiresAt > now) {
        throw new Error("Idempotency key is already in progress");
      }
      existing.status = "processing";
      existing.expiresAt = new Date(now + 300000).toISOString();
      existing.updatedAt = new Date(now).toISOString();
      return { owned: true, recordId: existing.id };
    }

    const record = {
      id: id("idem"),
      operationName,
      idempotencyKey,
      status: "processing",
      result: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300000).toISOString()
    };
    db.idempotencyRecords.push(record);
    return { owned: true, recordId: record.id };
  });

  if (!claim.owned) return claim.result;

  try {
    const result = await handler();
    return transact(db => {
      const record = db.idempotencyRecords.find(x => x.id === claim.recordId);
      if (!record) throw new Error("Idempotency record disappeared");
      record.status = "completed";
      record.result = result;
      record.expiresAt = null;
      record.updatedAt = new Date().toISOString();
      return result;
    });
  } catch (error) {
    await transact(db => {
      const record = db.idempotencyRecords.find(x => x.id === claim.recordId);
      if (record) db.idempotencyRecords.splice(db.idempotencyRecords.indexOf(record), 1);
    });
    throw error;
  }
}


export async function recoverExpiredWorkers() {
  const db = await loadDb();
  const expired = db.workers.filter(worker =>
    worker.leaseId &&
    worker.leaseExpiresAt &&
    Date.parse(worker.leaseExpiresAt) <= Date.now() &&
    [WORKER_STATUS.RUNNING, WORKER_STATUS.READY].includes(worker.status)
  );

  const recovered = [];
  for (const worker of expired) {
    recovered.push(await recoverAgentFromWorkerLoss(worker.id));
  }
  return recovered;
}

export async function recoverAgentFromWorkerLoss(workerId) {
  const db = await loadDb();
  const worker = db.workers.find(x => x.id === workerId);
  if (!worker) throw new Error("Worker not found");
  if (!worker.agentInstanceId) throw new Error("Worker has no agent instance");

  const oldAgent = db.agentInstances.find(x => x.id === worker.agentInstanceId);
  if (!oldAgent) throw new Error("Agent instance not found");

  if (!worker.leaseId || !worker.leaseExpiresAt || Date.parse(worker.leaseExpiresAt) > Date.now()) {
    return { status: "not_expired", agent: oldAgent };
  }

  if ([AGENT_STATUS.CANCELLED, AGENT_STATUS.COMPLETED].includes(oldAgent.status)) {
    await recoverExpiredWorkerLease(workerId);
    return { status: "terminal", agent: oldAgent };
  }

  await transact(state => {
    const current = state.agentInstances.find(x => x.id === oldAgent.id);
    const currentWorker = state.workers.find(x => x.id === workerId);
    if (!current || !currentWorker) throw new Error("Recovery records disappeared");

    const now = new Date().toISOString();
    const oldWorkspace = state.workspaces.find(x => x.id === current.workspaceId);
    if (oldWorkspace) {
      oldWorkspace.status = "stopped";
      oldWorkspace.stoppedAt = now;
    }
    current.status = AGENT_STATUS.FAILED;
    current.executionState = "recovery_required";
    current.completedAt = null;
    currentWorker.status = WORKER_STATUS.FAILED;
    currentWorker.runtimeState = WORKER_RUNTIME_STATE.FAILED;
    currentWorker.lastError = "Worker lease expired; instance recovery started";
    currentWorker.leaseId = null;
    currentWorker.leaseOwner = null;
    currentWorker.leaseExpiresAt = null;
    currentWorker.heartbeatAt = now;

    const task = state.tasks.find(x => x.id === current.taskId);
    if (task) {
      task.status = TASK_STATUS.QUEUED;
      task.updatedAt = now;
    }

    state.recoveryEvents.push({
      id: id("recovery"),
      taskId: current.taskId,
      agentInstanceId: current.id,
      workerId: currentWorker.id,
      type: "worker_lease_expired",
      checkpointVersion: currentWorker.checkpointAt ? 1 : 0,
      createdAt: now
    });

    state.agentMessages.push({
      id: id("msg"),
      agentInstanceId: current.id,
      role: "system",
      content: "Worker lease expired; task queued for agent recreation.",
      metadata: { recovery: true, workerId: currentWorker.id },
      createdAt: now
    });
  });

  const recreated = await recreateAgentInstance(oldAgent.taskId, oldAgent.id);
  return { status: "recreated", agent: recreated };
}

export async function recreateAgentInstance(taskId, previousAgentId = null) {
  const db = await loadDb();
  const task = db.tasks.find(x => x.id === taskId);
  if (!task) throw new Error("Task not found");

  const live = db.agentInstances.find(x =>
    x.taskId === taskId &&
    [AGENT_STATUS.PROVISIONING, AGENT_STATUS.READY, AGENT_STATUS.RUNNING, AGENT_STATUS.WAITING_USER].includes(x.status)
  );
  if (live) return live;

  const agent = await spawnAgentForTaskForRecovery(task, previousAgentId);
  return startAgent(agent.id);
}

async function spawnAgentForTaskForRecovery(task, previousAgentId) {
  const { mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const workspacePath = path.join(path.resolve(process.env.RAZEKIT_WORKSPACE_ROOT || "data/workspaces"), task.id);
  await mkdir(workspacePath, { recursive: true });

  return transact(db => {
    const freshTask = db.tasks.find(x => x.id === task.id);
    if (!freshTask) throw new Error("Task not found");

    const existing = db.agentInstances.find(x =>
      x.taskId === task.id &&
      [AGENT_STATUS.PROVISIONING, AGENT_STATUS.READY, AGENT_STATUS.RUNNING, AGENT_STATUS.WAITING_USER].includes(x.status)
    );
    if (existing) return existing;

    const agentType = agentTypeForTask(freshTask.taskType);
    const now = new Date().toISOString();
    const previousAgent = previousAgentId
      ? db.agentInstances.find(x => x.id === previousAgentId) || null
      : null;
    const previousWorker = previousAgent?.workerId
      ? db.workers.find(x => x.id === previousAgent.workerId) || null
      : null;

    const workspace = {
      id: id("ws"),
      taskId: task.id,
      agentInstanceId: null,
      path: workspacePath,
      status: "active",
      isolated: true,
      recreated: true,
      previousAgentId,
      createdAt: now,
      stoppedAt: null
    };
    const worker = {
      id: id("worker"),
      taskId: task.id,
      agentInstanceId: null,
      runtime: agentType === AGENT_TYPES.KONAMI ? "game-worker" : "app-web-worker",
      status: WORKER_STATUS.READY,
      runtimeState: WORKER_RUNTIME_STATE.READY,
      heartbeatAt: now,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      checkpoint: previousWorker?.checkpoint || null,
      checkpointAt: previousWorker?.checkpointAt || null,
      createdAt: now,
      stoppedAt: null,
      recreated: true,
      previousWorkerId: previousWorker?.id || null
    };
    const agent = {
      id: id(agentType),
      taskId: task.id,
      agentType,
      status: AGENT_STATUS.READY,
      workspaceId: workspace.id,
      workerId: worker.id,
      modelConfig: {
        orchestrator: "dual-model",
        primary: "fable-5.1",
        reasoningReviewer: "gpt-astra"
      },
      toolConfig: {
        manifest: toolManifestForTask(freshTask.taskType, freshTask.requestedTools || []),
        isolation: "task-scoped"
      },
      budgetLimit: Number(freshTask.maxBudget),
      budgetUsed: Number(freshTask.actualSpend || 0),
      iteration: 0,
      executionState: "recovered",
      lastHeartbeat: now,
      createdAt: now,
      completedAt: null,
      recreatedFromAgentId: previousAgentId,
      recoveryCount: Number(freshTask.recoveryCount || 0) + 1
    };

    workspace.agentInstanceId = agent.id;
    worker.agentInstanceId = agent.id;

    db.workspaces.push(workspace);
    db.workers.push(worker);
    db.agentInstances.push(agent);

    const previousSessions = previousAgentId
      ? db.modelSessions.filter(x => x.agentInstanceId === previousAgentId)
      : [];
    const previousMessages = previousAgentId
      ? db.modelMessages.filter(x => x.agentInstanceId === previousAgentId)
      : [];
    const previousUsage = previousAgentId
      ? db.modelUsage.filter(x => x.agentInstanceId === previousAgentId)
      : [];
    const previousBlackboard = previousAgentId
      ? db.agentBlackboards.filter(x => x.agentInstanceId === previousAgentId)
      : [];
    const previousSnapshots = previousAgentId
      ? db.contextSnapshots.filter(x => x.agentInstanceId === previousAgentId)
      : [];
    const previousRuns = previousAgentId
      ? db.orchestrationRuns.filter(x => x.agentInstanceId === previousAgentId)
      : [];

    if (previousSessions.length > 0) {
      const sessionIdMap = new Map();
      for (const source of previousSessions) {
        const cloned = {
          ...source,
          id: id("session"),
          agentInstanceId: agent.id,
          createdAt: now,
          updatedAt: now,
          lastError: null
        };
        sessionIdMap.set(source.id, cloned.id);
        db.modelSessions.push(cloned);
      }
      for (const source of previousMessages) {
        db.modelMessages.push({
          ...source,
          id: id("modelmsg"),
          sessionId: sessionIdMap.get(source.sessionId) || source.sessionId,
          agentInstanceId: agent.id,
          createdAt: now
        });
      }
      for (const source of previousUsage) {
        db.modelUsage.push({
          ...source,
          id: id("usage"),
          agentInstanceId: agent.id,
          createdAt: now
        });
      }
    }

    for (const source of previousBlackboard) {
      db.agentBlackboards.push({
        ...source,
        id: id("bb"),
        agentInstanceId: agent.id,
        updatedAt: now
      });
    }
    for (const source of previousSnapshots) {
      db.contextSnapshots.push({
        ...source,
        id: id("snapshot"),
        agentInstanceId: agent.id,
        createdAt: now
      });
    }
    for (const source of previousRuns) {
      db.orchestrationRuns.push({
        ...source,
        id: id("orch"),
        agentInstanceId: agent.id,
        createdAt: now,
        updatedAt: now,
        status: "ready"
      });
    }

    db.recoveryEvents.push({
      id: id("recovery"),
      taskId: task.id,
      agentInstanceId: agent.id,
      workerId: worker.id,
      type: "agent_recreated",
      checkpointVersion: previousWorker?.checkpointAt ? 1 : 0,
      previousAgentId,
      createdAt: now
    });

    if (previousWorker?.checkpoint) {
      db.recoveryEvents.push({
        id: id("recovery"),
        taskId: task.id,
        agentInstanceId: agent.id,
        workerId: worker.id,
        type: "checkpoint_restored",
        checkpointVersion: previousWorker.checkpointAt ? 1 : 0,
        previousAgentId,
        createdAt: now
      });
    }

    freshTask.agentInstanceId = agent.id;
    freshTask.agentType = agentType;
    freshTask.status = TASK_STATUS.QUEUED;
    freshTask.recoveryCount = agent.recoveryCount;
    freshTask.updatedAt = now;

    db.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: "Agent instance recreated from recovery.",
      metadata: {
        recovery: true,
        previousAgentId,
        checkpointAvailable: Boolean(previousWorker?.checkpoint)
      },
      createdAt: now
    });

    return agent;
  });
}

function assertJobLease(job, leaseId) {
  if (!leaseId || job.leaseId !== leaseId) throw new Error("Invalid job lease");
  if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= Date.now()) {
    throw new Error("Job lease expired");
  }
}
