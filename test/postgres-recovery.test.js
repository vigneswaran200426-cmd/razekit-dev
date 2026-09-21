import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Worker, checkpoint and recovery semantics on Postgres.
//
// These are the parts of the system that only matter when something has already
// gone wrong — a container is killed mid-build, a lease expires, a worker stops
// heartbeating. They were written against a store where one process owned all
// the state; the whole question here is whether they still hold when the state
// is shared and the process that wrote it is gone.

const DATABASE_URL = process.env.RAZEKIT_DATABASE_URL;
const SCHEMA = process.env.RAZEKIT_DATABASE_SCHEMA || "razekit_dev";

if (!DATABASE_URL) {
  test("postgres recovery", { skip: "RAZEKIT_DATABASE_URL is not set" }, () => {});
}
const suite = DATABASE_URL ? test : test.skip;

process.env.RAZEKIT_STORE = "postgres";
// Set before reliability.js is imported, which reads it once at module load.
// The default backoff is one second and a single round trip to Neon is a
// quarter of that, so a test that raced the real backoff would pass or fail
// depending on network latency rather than on behaviour.
process.env.RAZEKIT_JOB_BACKOFF_MS = "60000";
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "razekit-pg-rec-"));
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceRoot;

const store = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES } = await import("../src/domain.js");
const { spawnAgentForTask } = await import("../src/agent-manager.js");
const {
  createJob, claimNextJob, retryJob, writeCheckpoint, getCheckpoint,
  recoverExpiredJobs, JOB_STATUS
} = await import("../src/reliability.js");
const {
  registerWorkerPool, registerProductionWorker, heartbeatProductionWorker,
  claimProductionJob, listProductionWorkers
} = await import("../src/production-runtime.js");

const TAG = "rec" + Date.now().toString(36);
// Job kinds are per-run. The database is shared between runs, and a claim
// filtered on a fixed kind would happily pick up a previous run's leftovers.
const KIND_RECOVERY = "recovery-probe-" + TAG;
const KIND_POOL = "pool-probe-" + TAG;

async function makeAgent(title) {
  const now = new Date().toISOString();
  const task = {
    id: store.id("task"), userId: TAG + "-u", tenantId: TAG + "-t",
    taskType: "website", title, originalRequest: "x", specification: "x",
    requestedTools: ["filesystem"], estimatedBudget: 1, maxBudget: 10, actualSpend: 0,
    currency: "USD", status: TASK_STATUS.READY_FOR_AGENT, agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: { autonomousExecution: true, scopes: [], authorizedAt: now },
    createdAt: now, updatedAt: now, testTag: TAG
  };
  await store.transact((db) => { db.tasks.push(task); });
  return spawnAgentForTask(task.id);
}

suite("a checkpoint written by one connection is readable by another", async () => {
  // Recovery depends on this exactly: the process that resumes a task is not
  // the process that checkpointed it.
  const agent = await makeAgent("Checkpoint probe");
  const payload = { step: "run-tests", attempt: 2, cursor: "abc" };

  await writeCheckpoint(
    { agentInstanceId: agent.id, taskId: agent.taskId, kind: "app_web_execution", scopeId: "run-1" },
    payload,
    { runId: "run-1" }
  );

  const { PostgresStore } = await import("../src/adapters/postgres-store.js");
  const other = new PostgresStore({
    connectionString: DATABASE_URL, schema: SCHEMA,
    collections: store.COLLECTIONS, initialState: store.INITIAL_STATE, migrate: store.migrateState
  });
  try {
    const db = await other.loadDb();
    const found = db.stateCheckpoints.find(
      (c) => c.agentInstanceId === agent.id && c.kind === "app_web_execution"
    );
    assert.ok(found, "a separate connection must see the checkpoint");
    assert.deepEqual(found.checkpoint, payload, "the checkpoint must survive the round trip intact");
  } finally {
    await other.end();
  }

  // And the module's own reader agrees.
  const viaModule = await getCheckpoint(agent.id, "app_web_execution", "run-1");
  assert.deepEqual(viaModule.checkpoint, payload);
});

suite("an expired job lease is recovered and becomes claimable again", async () => {
  // The container holding this lease is gone. Nothing will ever complete the
  // job, so the only thing that can rescue it is lease expiry observed by
  // someone else.
  const agent = await makeAgent("Lease recovery");
  const job = await createJob({
    agentInstanceId: agent.id, kind: KIND_RECOVERY,
    resourceClass: "cpu", idempotencyKey: "rec-" + TAG
  });

  const claimed = await claimNextJob("doomed-worker", 60_000, { kind: KIND_RECOVERY });
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, JOB_STATUS.RUNNING);

  // Expire the lease in the database, as wall-clock would have.
  await store.transact((db) => {
    const row = db.jobs.find((j) => j.id === job.id);
    row.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
  });

  // recoverExpiredJobs reports the ids it rescued, not the rows.
  const recovered = await recoverExpiredJobs();
  assert.ok(
    recovered.includes(job.id),
    "the expired job should be recovered, got: " + JSON.stringify(recovered)
  );

  const after = (await store.loadDb()).jobs.find((j) => j.id === job.id);
  assert.notEqual(after.status, JOB_STATUS.RUNNING, "a recovered job must not still look running");
  assert.equal(after.status, JOB_STATUS.RETRYING);
  assert.equal(after.leaseId, null, "the dead worker's lease must be released");

  // Recovery applies a backoff, so the job is deliberately NOT claimable yet —
  // a job that failed because its worker died should not be handed straight
  // back out. Fast-forward past the backoff rather than sleeping through it.
  const tooEarly = await claimNextJob("rescue-worker", 30_000, { kind: KIND_RECOVERY });
  assert.equal(tooEarly, null, "a job inside its retry backoff must not be claimable");

  await store.transact((db) => {
    const row = db.jobs.find((j) => j.id === job.id);
    row.availableAt = new Date(Date.now() - 1000).toISOString();
  });

  // A different worker can now pick it up.
  const reclaimed = await claimNextJob("rescue-worker", 30_000, { kind: KIND_RECOVERY });
  assert.ok(reclaimed, "the recovered job must be claimable again");
  assert.equal(reclaimed.id, job.id);
  assert.equal(reclaimed.leaseOwner, "rescue-worker");
  assert.ok(reclaimed.attempts >= 2, "the retry must be counted, got " + reclaimed.attempts);
});

suite("a worker pool assigns each job once and rejects a stale worker", async () => {
  const pool = await registerWorkerPool({
    name: "pg-pool-" + TAG, resourceClass: "cpu", runtime: "container", capacity: 3
  });

  for (const id of [TAG + "-w1", TAG + "-w2"]) {
    await registerProductionWorker({
      poolId: pool.id, workerId: id, runtime: "container",
      resourceClass: "cpu", capabilities: ["node"], metadata: { testTag: TAG }
    });
  }

  const agent = await makeAgent("Pool probe");
  const jobs = [];
  for (let i = 0; i < 2; i += 1) {
    jobs.push(await createJob({
      agentInstanceId: agent.id, kind: KIND_POOL,
      resourceClass: "cpu", idempotencyKey: `pool-${TAG}-${i}`
    }));
  }

  const a = await claimProductionJob(pool.id, TAG + "-w1");
  const b = await claimProductionJob(pool.id, TAG + "-w2");
  assert.ok(a && b, "both workers should receive work");
  assert.notEqual(a.job.id, b.job.id, "two workers must never get the same job");

  // A worker that stopped heartbeating is taken out of rotation without any
  // cooperation from it — the machine may simply be gone.
  await store.transact((db) => {
    const w = db.productionWorkers.find((x) => x.workerId === TAG + "-w1");
    w.heartbeatAt = new Date(Date.now() - 10 * 60_000).toISOString();
    w.status = "ready";
    w.activeJobId = null;
  });
  await store.transact((db) => {
    const p = db.workerPools.find((x) => x.id === pool.id);
    p.activeWorkers = 0;
  });

  await claimProductionJob(pool.id, TAG + "-w1");
  const stale = (await listProductionWorkers(pool.id)).find((w) => w.workerId === TAG + "-w1");
  assert.equal(stale.status, "offline", "a worker past its heartbeat timeout must be marked offline");
  await assert.rejects(
    () => heartbeatProductionWorker(TAG + "-w1", {}),
    /not accepting heartbeats/,
    "an offline worker must not resume by heartbeating from the dead"
  );
});

test.after(async () => {
  if (DATABASE_URL) {
    const native = await store.nativeStore();
    const pool = await native.getPool();
    // Identify children BEFORE deleting the tagged parents. Deleting first
    // leaves nothing to match on, which is how earlier runs left debris behind.
    const db = await store.loadDb();
    const ids = new Set(db.tasks.filter((t) => t.testTag === TAG).map((t) => t.id));
    const poolIds = new Set(db.workerPools.filter((p) => p.name === "pg-pool-" + TAG).map((p) => p.id));
    // Messages, blackboards and model sessions hang off the agent, not the
    // task, so filtering on taskId alone leaves them behind.
    const agentIds = new Set(db.agentInstances.filter((a) => ids.has(a.taskId)).map((a) => a.id));
    await pool.query(`DELETE FROM ${SCHEMA}.rk_state WHERE data->>'testTag' = $1`, [TAG]);
    if (ids.size || poolIds.size) {
      await store.transact((state) => {
        for (const key of store.COLLECTIONS) {
          if (!Array.isArray(state[key])) continue;
          state[key] = state[key].filter(
            (row) =>
              !ids.has(row?.taskId) &&
              !agentIds.has(row?.agentInstanceId) &&
              !poolIds.has(row?.poolId) &&
              !poolIds.has(row?.id)
          );
        }
      });
    }
    await store.closeStore();
  }
  await rm(workspaceRoot, { recursive: true, force: true });
});
