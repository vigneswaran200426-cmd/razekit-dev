import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-recovery-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-recovery-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_JOB_BACKOFF_MS = "1";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_STATUS, WORKER_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const {
  writeCheckpoint,
  getCheckpoint,
  createJob,
  claimNextJob,
  completeJob,
  retryJob,
  blockJob,
  recoverExpiredJobs,
  runIdempotent,
  recoverExpiredWorkers
} = await import("../src/reliability.js");
const { leaseWorker, checkpointWorker } = await import("../src/worker-runtime.js");

async function makeTask(title = "Recovery Task") {
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    userId: "recovery-user",
    taskType: "website",
    title,
    originalRequest: "Build " + title,
    specification: "Build " + title,
    requestedTools: ["filesystem"],
    estimatedBudget: 5,
    maxBudget: 20,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: "niomi",
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes: ["workspace:read", "workspace:write"],
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
      text: "Recovery test acceptance",
      status: "pending"
    });
  });

  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return agent;
}

test("durable checkpoints persist and version per scope", async () => {
  const agent = await makeTask("Checkpointing");

  const first = await writeCheckpoint(
    { agentInstanceId: agent.id, taskId: agent.taskId, kind: "execution", scopeId: "plan-1" },
    { step: "install", state: "passed" }
  );
  const second = await writeCheckpoint(
    { agentInstanceId: agent.id, taskId: agent.taskId, kind: "execution", scopeId: "plan-1" },
    { step: "build", state: "running" }
  );

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.deepEqual((await getCheckpoint(agent.id, "execution", "plan-1")).checkpoint, {
    step: "build",
    state: "running"
  });

  const db = await loadDb();
  assert.ok(db.schemaVersion >= 2);
  assert.ok(db.migrationsApplied.includes("phase-6-reliability"));
});

test("expired worker lease recreates exactly one active agent and carries checkpoint", async () => {
  const agent = await makeTask("Worker Recovery");
  const db = await loadDb();
  const worker = db.workers.find(x => x.id === agent.workerId);
  const lease = await leaseWorker(worker.id, "recovery-test", 1000);

  await checkpointWorker(worker.id, lease.leaseId, {
    executionPlanId: "plan-recover",
    lastPassedStep: "step-2"
  });

  await transact(state => {
    const current = state.workers.find(x => x.id === worker.id);
    current.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
  });

  const results = await recoverExpiredWorkers();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "recreated");

  const after = await loadDb();
  const activeAgents = after.agentInstances.filter(x =>
    x.taskId === agent.taskId &&
    [AGENT_STATUS.READY, AGENT_STATUS.RUNNING, AGENT_STATUS.WAITING_USER].includes(x.status)
  );
  assert.equal(activeAgents.length, 1);
  assert.notEqual(activeAgents[0].id, agent.id);
  assert.equal(activeAgents[0].recreatedFromAgentId, agent.id);

  const recoveredWorker = after.workers.find(x => x.id === activeAgents[0].workerId);
  assert.deepEqual(recoveredWorker.checkpoint, {
    executionPlanId: "plan-recover",
    lastPassedStep: "step-2"
  });

  const oldAgent = after.agentInstances.find(x => x.id === agent.id);
  const oldWorker = after.workers.find(x => x.id === worker.id);
  const activeWorkspaces = after.workspaces.filter(x =>
    x.taskId === agent.taskId && x.status === "active"
  );
  assert.equal(activeWorkspaces.length, 1);
  assert.equal(oldAgent.status, AGENT_STATUS.FAILED);
  assert.equal(oldWorker.status, WORKER_STATUS.FAILED);
  assert.equal(after.tasks.find(x => x.id === agent.taskId).agentInstanceId, activeAgents[0].id);
});

test("expired job leases are retried and eventually dead-lettered", async () => {
  const agent = await makeTask("Job Recovery");
  const job = await createJob({
    agentInstanceId: agent.id,
    kind: "test-job",
    payload: { value: 1 },
    maxAttempts: 2,
    idempotencyKey: "job-recovery-1"
  });

  const first = await claimNextJob("worker-a", 1000);
  assert.equal(first.id, job.id);

  await transact(db => {
    const current = db.jobs.find(x => x.id === job.id);
    current.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
  });

  const recovered = await recoverExpiredJobs();
  assert.deepEqual(recovered, [job.id]);

  const second = await claimNextJob("worker-b", 1000);
  assert.equal(second.attempts, 2);

  const dead = await retryJob(job.id, second.leaseId, "second failure", 0);
  assert.equal(dead.status, "dead_letter");

  const db = await loadDb();
  assert.equal(db.jobs.find(x => x.id === job.id).status, "dead_letter");
});

test("completed jobs require the active lease and persist the result", async () => {
  const agent = await makeTask("Job Completion");
  const job = await createJob({
    agentInstanceId: agent.id,
    kind: "completion-job",
    payload: { value: 2 },
    idempotencyKey: "job-completion-1"
  });

  const claimed = await claimNextJob("worker-c", 1000);
  assert.equal(claimed.id, job.id);

  await assert.rejects(
    () => completeJob(job.id, "wrong-lease", { ok: true }),
    /Invalid job lease/
  );

  const completed = await completeJob(job.id, claimed.leaseId, { ok: true });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, { ok: true });
});

test("idempotent operations reject a second concurrent claim and can recover stale claims", async () => {
  const { transact: dbTransact } = await import("../src/store.js");
  await dbTransact(db => {
    db.idempotencyRecords.push({
      id: id("idem"),
      operationName: "stale-operation",
      idempotencyKey: "stale-key",
      status: "processing",
      result: null,
      createdAt: new Date(Date.now() - 600000).toISOString(),
      updatedAt: new Date(Date.now() - 600000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
  });

  const recovered = await runIdempotent("stale-operation", "stale-key", async () => ({
    recovered: true
  }));
  assert.deepEqual(recovered, { recovered: true });

  await assert.rejects(
    async () => {
      await dbTransact(db => {
        db.idempotencyRecords.push({
          id: id("idem"),
          operationName: "active-operation",
          idempotencyKey: "active-key",
          status: "processing",
          result: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString()
        });
      });
      await runIdempotent("active-operation", "active-key", async () => ({ no: "run" }));
    },
    /already in progress/
  );
});

test("idempotent operations return the first committed result", async () => {
  let calls = 0;

  const first = await runIdempotent("test-operation", "same-key", async () => {
    calls += 1;
    return { result: "first", calls };
  });
  const second = await runIdempotent("test-operation", "same-key", async () => {
    calls += 1;
    return { result: "second", calls };
  });

  assert.deepEqual(first, { result: "first", calls: 1 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("job creation is idempotent per agent and idempotency key", async () => {
  const agent = await makeTask("Idempotent Job");
  const first = await createJob({
    agentInstanceId: agent.id,
    kind: "same-job",
    payload: { attempt: 1 },
    idempotencyKey: "same-job-key"
  });
  const second = await createJob({
    agentInstanceId: agent.id,
    kind: "same-job",
    payload: { attempt: 2 },
    idempotencyKey: "same-job-key"
  });

  assert.equal(first.id, second.id);
  assert.deepEqual(second.payload, { attempt: 1 });
});

test("blocked jobs release their lease without becoming retryable", async () => {
  const agent = await makeTask("Blocked Job");
  const job = await createJob({
    agentInstanceId: agent.id,
    kind: "blocked-job"
  });
  const claimed = await claimNextJob("worker-d", 1000, { agentInstanceId: agent.id, kind: "blocked-job" });
  const blocked = await blockJob(job.id, claimed.leaseId, "Needs external decision");

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.leaseId, null);

  const db = await loadDb();
  assert.equal(db.jobs.find(x => x.id === job.id).status, "blocked");
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
