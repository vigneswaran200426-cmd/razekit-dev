import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-runtime-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-runtime-workspaces-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;

const { transact, id } = await import("../src/store.js");
const { WORKER_STATUS } = await import("../src/domain.js");
const {
  leaseWorker,
  renewWorkerLease,
  releaseWorkerLease,
  checkpointWorker,
  getWorkerRuntime,
  recoverExpiredWorkerLease
} = await import("../src/worker-runtime.js");
const { LocalProcessRuntime } = await import("../src/adapters/local-process-runtime.js");

async function makeWorker() {
  const worker = {
    id: id("worker"),
    taskId: id("task"),
    agentInstanceId: id("niomi"),
    runtime: "app-web-worker",
    status: WORKER_STATUS.READY,
    runtimeState: "ready",
    heartbeatAt: null,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: null,
    checkpointAt: null,
    createdAt: new Date().toISOString(),
    stoppedAt: null
  };
  await transact(db => db.workers.push(worker));
  return worker;
}

test("worker lease is exclusive and renewable", async () => {
  const worker = await makeWorker();
  const first = await leaseWorker(worker.id, "owner-a", 5000);

  assert.equal(first.ownerId, "owner-a");
  await assert.rejects(
    () => leaseWorker(worker.id, "owner-b", 5000),
    /already leased/
  );

  const renewed = await renewWorkerLease(worker.id, first.leaseId, 5000);
  assert.equal(renewed.leaseId, first.leaseId);

  await releaseWorkerLease(worker.id, first.leaseId);
  const second = await leaseWorker(worker.id, "owner-b", 5000);
  assert.notEqual(second.leaseId, first.leaseId);
});

test("worker checkpoint is bound to the current lease", async () => {
  const worker = await makeWorker();
  const lease = await leaseWorker(worker.id, "owner", 5000);

  const checkpoint = await checkpointWorker(worker.id, lease.leaseId, {
    planId: "plan-1",
    stepId: "step-2",
    status: "running"
  });

  assert.equal(checkpoint.checkpoint.stepId, "step-2");
  assert.equal((await getWorkerRuntime(worker.id)).checkpoint.planId, "plan-1");

  await assert.rejects(
    () => checkpointWorker(worker.id, "wrong-lease", {}),
    /Invalid worker lease/
  );
});

test("expired leases can be recovered", async () => {
  const worker = await makeWorker();
  const lease = await leaseWorker(worker.id, "owner", 1000);
  await transact(db => {
    const item = db.workers.find(x => x.id === worker.id);
    item.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
  });

  const before = await getWorkerRuntime(worker.id);
  assert.equal(before.leaseExpired, true);

  const recovered = await recoverExpiredWorkerLease(worker.id);
  assert.equal(recovered.leaseId, null);
  assert.equal(recovered.status, WORKER_STATUS.READY);
});

test("local process runtime runs only inside the configured workspace", async () => {
  const runtime = new LocalProcessRuntime({ workspaceRoot: workspaceDir });

  const result = await runtime.execute({
    kind: "command",
    executable: process.platform === "win32" ? "node.exe" : "node",
    args: ["-e", "process.stdout.write('hello')"],
    cwd: "."
  });

  assert.equal(result.stdout, "hello");

  await assert.rejects(
    () => runtime.execute({
      kind: "command",
      executable: "node",
      args: ["-e", "process.stdout.write('no')"],
      cwd: ".."
    }),
    /escapes workspace root/
  );

  await assert.rejects(
    () => runtime.execute({
      kind: "command",
      executable: "sh",
      args: ["-c", "echo unsafe"]
    }),
    /Executable is not allowed/
  );
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});
