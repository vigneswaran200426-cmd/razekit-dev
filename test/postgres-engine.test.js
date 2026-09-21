import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The engine itself, running on Postgres.
//
// The adapter tests prove the store is correct in isolation. This proves the
// thing that actually matters: that all 24 modules — agent manager, orchestrator,
// executor, verifier, budget, queue — work through it unchanged, and that a
// second process sees the same world. An interface that exists is not a working
// path, and this is the difference.

const DATABASE_URL = process.env.RAZEKIT_DATABASE_URL;
const SCHEMA = process.env.RAZEKIT_DATABASE_SCHEMA || "razekit_dev";

if (!DATABASE_URL) {
  test("postgres engine", { skip: "RAZEKIT_DATABASE_URL is not set" }, () => {});
}
const suite = DATABASE_URL ? test : test.skip;

process.env.RAZEKIT_STORE = "postgres";
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "razekit-pg-ws-"));
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceRoot;

const store = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES, AGENT_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent } = await import("../src/agent-manager.js");
const { ModelAdapterRegistry } = await import("../src/model-runtime.js");
const { ModelOrchestrator } = await import("../src/model-orchestrator.js");
const { configureModelRegistry, MODEL_MODE } = await import("../src/model-providers.js");
const { advanceAgent, LOOP_STAGE } = await import("../src/autonomous-loop.js");
const { createJob, claimNextJob, completeJob, JOB_STATUS } = await import("../src/reliability.js");

const TAG = "eng" + Date.now().toString(36);

function orchestrator() {
  const registry = new ModelAdapterRegistry();
  const previous = process.env.RAZEKIT_MODEL_MODE;
  process.env.RAZEKIT_MODEL_MODE = MODEL_MODE.TEST;
  configureModelRegistry(registry);
  if (previous === undefined) delete process.env.RAZEKIT_MODEL_MODE;
  else process.env.RAZEKIT_MODEL_MODE = previous;
  return new ModelOrchestrator({ registry });
}

async function makeTask(title, { maxBudget = 5 } = {}) {
  const now = new Date().toISOString();
  const task = {
    id: store.id("task"),
    userId: TAG + "-user",
    tenantId: TAG + "-tenant",
    taskType: "website",
    title,
    originalRequest: "Build " + title,
    specification: "Build " + title,
    requestedTools: ["filesystem", "node"],
    estimatedBudget: 1,
    maxBudget,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: { autonomousExecution: true, scopes: [], authorizedAt: now },
    createdAt: now,
    updatedAt: now,
    testTag: TAG
  };
  await store.transact((db) => {
    db.tasks.push(task);
    db.acceptanceCriteria.push({
      id: store.id("ac"),
      taskId: task.id,
      text: "Tests pass and an artifact exists",
      status: "pending",
      testTag: TAG
    });
  });
  return task;
}

async function runToSettled(agentId, orch, max = 30) {
  const stages = [];
  for (let i = 0; i < max; i += 1) {
    const r = await advanceAgent(agentId, { orchestrator: orch });
    stages.push(r.stage);
    if ([LOOP_STAGE.COMPLETED, LOOP_STAGE.BLOCKED].includes(r.stage)) return { stages, result: r };
    if (r.stage === LOOP_STAGE.IDLE && !r.retryable && !r.busy) return { stages, result: r };
  }
  throw new Error("did not settle: " + stages.join(" -> "));
}

suite("the store really is Postgres, not the file", async () => {
  assert.equal(store.storeKind(), "postgres");
  // The guard that stops a deployment booting on the process-local store.
  assert.doesNotThrow(() => store.assertProductionStore());
});

suite("a full build runs end to end with Postgres as the source of truth", async () => {
  const orch = orchestrator();
  const task = await makeTask("Postgres landing page");
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);

  const { stages, result } = await runToSettled(agent.id, orch);
  assert.equal(result.stage, LOOP_STAGE.COMPLETED, "stages: " + stages.join(" -> "));

  // Every stage of the documented machine ran, against the database.
  for (const stage of [LOOP_STAGE.PLAN, LOOP_STAGE.IMPLEMENT, LOOP_STAGE.EXECUTE, LOOP_STAGE.REVIEW]) {
    assert.ok(stages.includes(stage), `${stage} never ran; stages: ${stages.join(" -> ")}`);
  }

  const db = await store.loadDb();
  const finalTask = db.tasks.find((t) => t.id === task.id);
  const finalAgent = db.agentInstances.find((a) => a.id === agent.id);
  assert.equal(finalTask.status, TASK_STATUS.COMPLETED);
  assert.equal(finalAgent.status, AGENT_STATUS.COMPLETED);

  // Completion is still verification-gated, through the new store.
  const verification = db.verificationRuns.filter((v) => v.agentInstanceId === agent.id).pop();
  assert.equal(verification.status, "passed");
  assert.ok(db.acceptanceCriteria.filter((c) => c.taskId === task.id).every((c) => c.status === "passed"));

  // Real files, not just rows.
  const workspace = db.workspaces.find((w) => w.id === agent.workspaceId);
  assert.ok(existsSync(path.join(workspace.path, "index.html")));
  const built = await readFile(path.join(workspace.path, "dist", "index.html"), "utf8");
  assert.ok(built.includes("<main"));
});

suite("the state is in Postgres and visible to a separate connection", async () => {
  // The whole point of the port: another container can see this work. A fresh
  // store instance with its own pool stands in for that container.
  const { PostgresStore } = await import("../src/adapters/postgres-store.js");
  const other = new PostgresStore({
    connectionString: DATABASE_URL,
    schema: SCHEMA,
    collections: store.COLLECTIONS,
    initialState: store.INITIAL_STATE,
    migrate: store.migrateState
  });

  try {
    const db = await other.loadDb();
    const mine = db.tasks.filter((t) => t.testTag === TAG);
    assert.ok(mine.length > 0, "a separate connection must see the completed work");
    assert.ok(mine.every((t) => t.tenantId === TAG + "-tenant"), "tenant scoping survived");

    const agents = db.agentInstances.filter((a) => mine.some((t) => t.id === a.taskId));
    assert.ok(agents.length > 0, "agent instances are in the database, not in one process");
  } finally {
    await other.end();
  }
});

suite("queue: claim, complete and lease integrity through the real module", async () => {
  const task = await makeTask("Queue probe");
  const agent = await spawnAgentForTask(task.id);

  const job = await createJob({
    agentInstanceId: agent.id,
    kind: "pg-queue-probe",
    resourceClass: "cpu",
    idempotencyKey: "probe-" + TAG
  });
  assert.equal(job.status, JOB_STATUS.QUEUED);

  // Idempotency is preserved: the same key returns the same job, not a second.
  const again = await createJob({
    agentInstanceId: agent.id,
    kind: "pg-queue-probe",
    resourceClass: "cpu",
    idempotencyKey: "probe-" + TAG
  });
  assert.equal(again.id, job.id, "a repeated idempotency key must not create a second job");

  const claimed = await claimNextJob("worker-a", 30_000, { kind: "pg-queue-probe" });
  assert.ok(claimed, "the job should be claimable");
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, JOB_STATUS.RUNNING);
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.leaseId && claimed.leaseOwner === "worker-a");

  // A second worker must not get the same job.
  const second = await claimNextJob("worker-b", 30_000, { kind: "pg-queue-probe" });
  assert.equal(second, null, "a claimed job must not be handed to a second worker");

  // Completing with the wrong lease is refused; with the right one it settles.
  await assert.rejects(() => completeJob(job.id, "not-the-lease", { ok: true }));
  const done = await completeJob(job.id, claimed.leaseId, { ok: true });
  assert.equal(done.status, JOB_STATUS.COMPLETED);
});

test.after(async () => {
  if (DATABASE_URL) {
    // Remove only this run's rows; the database is shared with other runs.
    const pool = await (await store.nativeStore()).getPool();

    // Agents, workspaces, jobs and messages created by the engine do not carry
    // the tag, so they are found through this run's tasks — which means the
    // tasks have to be read BEFORE the tagged rows are deleted. Deleting first
    // leaves nothing to match on, and the orphans then interfere with the next
    // run's queries.
    const db = await store.loadDb();
    const ids = new Set(db.tasks.filter((t) => t.testTag === TAG).map((t) => t.id));
    const agentIds = new Set(
      db.agentInstances.filter((a) => ids.has(a.taskId)).map((a) => a.id)
    );

    await pool.query(`DELETE FROM ${SCHEMA}.rk_state WHERE data->>'testTag' = $1`, [TAG]);

    if (ids.size || agentIds.size) {
      await store.transact((state) => {
        for (const key of store.COLLECTIONS) {
          if (!Array.isArray(state[key])) continue;
          state[key] = state[key].filter(
            (row) => !ids.has(row?.taskId) && !agentIds.has(row?.agentInstanceId)
          );
        }
      });
    }
    await store.closeStore();
  }
  await rm(workspaceRoot, { recursive: true, force: true });
});
