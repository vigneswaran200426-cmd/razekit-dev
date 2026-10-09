import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-ops-sup-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_STORE = "json";
process.env.RAZEKIT_OPS_ALLOW_JSON_STORE = "true";
process.env.RAZEKIT_OPS_WORKSPACE_ROOT = path.join(dataDir, "ws");
process.env.RAZEKIT_OPS_LOG_DIR = path.join(dataDir, "logs");
process.env.RAZEKIT_OPS_HEARTBEAT_MS = "1000";

const { Supervisor, TaskParked, assertIsolation } = await import("../src/ops-supervisor.js");
const state = await import("../src/ops-state.js");
const { loadDb } = await import("../src/store.js");

test.after(() => rm(dataDir, { recursive: true, force: true }));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, { timeoutMs = 8000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + label);
    await sleep(25);
  }
}

/** Handlers driven by the test: each run waits for a release or an abort. */
function controllableHandlers() {
  const runs = [];
  return {
    runs,
    handlers: {
      async run(ctx) {
        const entry = { taskId: ctx.task.id, checkpoint: ctx.checkpoint, release: null, ctx };
        const released = new Promise(resolve => { entry.release = resolve; });
        runs.push(entry);
        await ctx.checkpointWrite("started", { attempt: ctx.task.attempts });
        const outcome = await Promise.race([
          released,
          new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }))
        ]);
        if (outcome instanceof Error) throw outcome;
        if (outcome?.park) throw new TaskParked("waiting_inference", { requestId: "req-x" }, 50);
        return { summary: "done " + ctx.task.id };
      }
    }
  };
}

function makeSupervisor(system, handlers, extra = {}) {
  return new Supervisor({ system, handlers, pollMs: 20, leaseMs: 2000, env: process.env, ...extra });
}

async function drive(supervisor, ticks = 1) {
  for (let i = 0; i < ticks; i += 1) await supervisor.tick();
}

test("the two systems are separate processes with separate heartbeats and queues", async () => {
  const a = controllableHandlers();
  const b = controllableHandlers();
  const builder = makeSupervisor("builder", a.handlers);
  const auditor = makeSupervisor("auditor", b.handlers);
  await builder.boot();
  await auditor.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "repo.inspect", title: "Builder-only task" });
  await drive(auditor, 3);
  assert.equal(b.runs.length, 0, "the auditor never claims a builder task");
  await drive(builder);
  await until(() => a.runs.length === 1, { label: "builder claim" });
  assert.equal(a.runs[0].taskId, task.id);
  await builder.heartbeat();
  await auditor.heartbeat();
  const beats = await state.getHeartbeats();
  assert.equal(beats.builder.processId, builder.processId);
  assert.equal(beats.auditor.processId, auditor.processId);
  assert.equal(beats.builder.currentTaskId, task.id);
  assert.equal(beats.auditor.currentTaskId, null);
  a.runs[0].release();
  await until(async () => (await state.getTask(task.id)).status === "completed", { label: "completion" });
  await builder.shutdown();
  await auditor.shutdown();
});

test("pause is completed by the process only after the running task stops, and survives a restart", async () => {
  const a = controllableHandlers();
  const first = makeSupervisor("builder", a.handlers);
  await first.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "repo.inspect", title: "Long task" });
  await drive(first);
  await until(() => a.runs.length === 1, { label: "claim" });

  const request = await state.createControlRequest({ targetType: "system", target: "builder", action: "pause", requestedBy: "owner@example.com" });
  assert.equal((await state.getControlRequest(request.id)).status, "requested");
  await drive(first);
  const resolved = await until(async () => {
    const r = await state.getControlRequest(request.id);
    return r.status === "completed" ? r : null;
  }, { label: "pause completion" });
  assert.equal(resolved.acceptedBy, first.processId);
  assert.equal(resolved.evidence.mode, "paused");
  const requeued = await state.getTask(task.id);
  assert.equal(requeued.status, "queued", "the interrupted task returns to the queue");
  assert.equal(requeued.attempts, 0, "an interruption does not consume an attempt");
  await first.shutdown();

  // A new process for the same system reads the persisted mode and stays paused.
  const second = makeSupervisor("builder", a.handlers);
  await second.boot();
  assert.equal(second.mode, "paused");
  await drive(second, 3);
  assert.equal(a.runs.length, 1, "nothing is claimed while paused");

  const resume = await state.createControlRequest({ targetType: "system", target: "builder", action: "resume", requestedBy: "owner@example.com" });
  await drive(second);
  assert.equal((await state.getControlRequest(resume.id)).status, "completed");
  await drive(second);
  await until(() => a.runs.length === 2, { label: "claim after resume" });
  assert.equal(a.runs[1].taskId, task.id);
  assert.equal(a.runs[1].checkpoint.step, "started", "the resumed run receives its last checkpoint");
  a.runs[1].release();
  await until(async () => (await state.getTask(task.id)).status === "completed", { label: "completion" });
  await second.shutdown();
});

test("stop current task cancels exactly that task; the other system is untouched", async () => {
  const a = controllableHandlers();
  const b = controllableHandlers();
  const builder = makeSupervisor("builder", a.handlers);
  const auditor = makeSupervisor("auditor", b.handlers);
  await builder.boot();
  await auditor.boot();
  const bt = await state.enqueueTask({ system: "builder", kind: "repo.inspect", title: "Builder work" });
  const at = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Auditor work" });
  await drive(builder);
  await drive(auditor);
  await until(() => a.runs.length === 1 && b.runs.length === 1, { label: "both running" });

  const stop = await state.createControlRequest({ targetType: "system", target: "builder", action: "stop_task", payload: { taskId: bt.id }, requestedBy: "owner" });
  await drive(builder);
  const done = await until(async () => {
    const r = await state.getControlRequest(stop.id);
    return r.status === "completed" ? r : null;
  }, { label: "stop completion" });
  assert.equal(done.evidence.finalStatus, "cancelled");
  assert.equal((await state.getTask(bt.id)).status, "cancelled");
  assert.equal((await state.getTask(at.id)).status, "running", "System B keeps working");
  b.runs[0].release();
  await until(async () => (await state.getTask(at.id)).status === "completed", { label: "auditor completion" });
  await builder.shutdown();
  await auditor.shutdown();
});

test("a request to a system with no live process stays requested, then expires", async () => {
  process.env.RAZEKIT_OPS_CONTROL_TTL_MS = "10000";
  const request = await state.createControlRequest({ targetType: "system", target: "auditor", action: "start", requestedBy: "owner", now: Date.now() - 20_000 });
  const read = await state.getControlRequest(request.id);
  assert.equal(read.status, "expired");
  assert.match(read.error, /No live process/);
  delete process.env.RAZEKIT_OPS_CONTROL_TTL_MS;
});

test("timeouts retry with backoff and dead-letter when attempts run out", async () => {
  const handlers = { run: ctx => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))) };
  const sup = makeSupervisor("builder", handlers);
  await sup.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "repo.inspect", title: "Hangs", timeoutMs: 1000, maxAttempts: 2 });
  await drive(sup);
  const retried = await until(async () => {
    const t = await state.getTask(task.id);
    return t.status === "queued" && t.attempts === 1 ? t : null;
  }, { label: "retry scheduled" });
  assert.match(retried.error, /timeout/);
  assert.ok(Date.parse(retried.availableAt) > Date.now(), "retry is delayed by backoff");
  await state.cancelTask(task.id, { by: "test", reason: "cleanup" });
  await sup.shutdown();
});

test("a task whose process died is recovered from its expired lease, and dead-letters on the last attempt", async () => {
  const task = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Orphaned", maxAttempts: 2 }, Date.now() - 10_000);
  const claimed = await state.claimTask("auditor", "dead-process", { leaseMs: 1000, now: Date.now() - 5000 });
  assert.equal(claimed.id, task.id);
  const reclaimed = await state.claimTask("auditor", "new-process", { leaseMs: 1000 });
  assert.equal(reclaimed.id, task.id, "the expired lease was recovered and the task claimed again");
  assert.equal(reclaimed.attempts, 2);
  const db = await loadDb();
  assert.ok(db.opsEvents.some(event => event.action === "task.lease_recovered" && event.taskId === task.id));
  await state.claimTask("auditor", "nobody", { leaseMs: 1000, now: Date.now() + 60_000 });
  assert.equal((await state.getTask(task.id)).status, "dead_letter");
});

test("duplicate work is prevented by idempotency keys and by one process per system", async () => {
  const one = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Audit slot 1", idempotencyKey: "audit:dup" });
  const two = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Audit slot 1 again", idempotencyKey: "audit:dup" });
  assert.equal(two.id, one.id);
  assert.equal(two.deduplicated, true);
  await state.cancelTask(one.id, { by: "test" });

  const a = controllableHandlers();
  const first = makeSupervisor("auditor", a.handlers);
  const second = makeSupervisor("auditor", a.handlers);
  await first.boot();
  await second.boot();
  assert.equal(await first.ensureLease(), true);
  assert.equal(await second.ensureLease(), false, "a second copy stands down");
  assert.deepEqual(await second.tick(), { standby: true });
  await first.shutdown();
  assert.equal(await second.ensureLease(), true, "it takes over once the first releases");
  await second.shutdown();
});

test("emergency stop interrupts the running task and blocks new claims until released", async () => {
  const a = controllableHandlers();
  const sup = makeSupervisor("builder", a.handlers);
  await sup.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "repo.inspect", title: "Interrupted by emergency" });
  await drive(sup);
  await until(() => a.runs.length === 1, { label: "claim" });
  await state.setSetting("emergency-stop", { engaged: true, by: "owner", at: new Date().toISOString(), reason: "test" }, "owner");
  await drive(sup);
  await until(async () => (await state.getTask(task.id)).status === "queued", { label: "requeue" });
  assert.equal(sup.status, "paused");
  await drive(sup, 3);
  assert.equal(a.runs.length, 1, "no claim while the emergency stop is engaged");
  await state.setSetting("emergency-stop", { engaged: false }, "owner");
  await drive(sup);
  await until(() => a.runs.length === 2, { label: "claim after release" });
  a.runs[1].release();
  await until(async () => (await state.getTask(task.id)).status === "completed", { label: "completion" });
  await sup.shutdown();
});

test("a task waiting for inference is parked, releases its lease, and comes back", async () => {
  const a = controllableHandlers();
  const sup = makeSupervisor("builder", a.handlers);
  await sup.boot();
  const task = await state.enqueueTask({ system: "builder", kind: "code.change", scopeArea: "niomi", title: "Needs the GPU" });
  await drive(sup);
  await until(() => a.runs.length === 1, { label: "claim" });
  a.runs[0].release({ park: true });
  const parked = await until(async () => {
    const t = await state.getTask(task.id);
    return t.status === "waiting_inference" ? t : null;
  }, { label: "parked" });
  assert.equal(parked.leaseOwner, null);
  assert.equal(parked.waitingFor.requestId, "req-x");
  assert.notEqual(parked.status, "completed", "never reported complete without an answer");
  await sleep(80);
  await drive(sup, 2);
  await until(() => a.runs.length === 2, { label: "resumed" });
  a.runs[1].release();
  await until(async () => (await state.getTask(task.id)).status === "completed", { label: "completion" });
  await sup.shutdown();
});

test("each system refuses to start when it can see the other system's secrets", () => {
  assert.throws(() => assertIsolation("auditor", { RAZEKIT_BUILDER_GITHUB_TOKEN: "x" }), /isolation/);
  assert.throws(() => assertIsolation("auditor", { GITHUB_TOKEN: "x" }), /isolation/);
  assert.throws(() => assertIsolation("builder", { RAZEKIT_ADMIN_TOKEN: "x" }), /isolation/);
  assert.doesNotThrow(() => assertIsolation("builder", { RAZEKIT_BUILDER_GITHUB_TOKEN: "x" }));
  assert.doesNotThrow(() => assertIsolation("auditor", {}));
});

test("a supervisor will not run beside a server on the per-process file store", async () => {
  const sup = makeSupervisor("builder", { run: async () => ({}) }, { env: { ...process.env, RAZEKIT_OPS_ALLOW_JSON_STORE: "" } });
  await assert.rejects(() => sup.boot(), /RAZEKIT_STORE=json cannot be used/);
});

test("a schedule slot runs once: a finished slot is not enqueued again", async () => {
  const first = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Slot 7", idempotencyKey: "audit:slot-7", dedupeScope: "all" });
  await state.cancelTask(first.id, { by: "test", reason: "finished" });
  const again = await state.enqueueTask({ system: "auditor", kind: "audit.cycle", title: "Slot 7", idempotencyKey: "audit:slot-7", dedupeScope: "all" });
  assert.equal(again.id, first.id);
  assert.equal(again.deduplicated, true);
  const rerun = await state.enqueueTask({ system: "builder", kind: "model.coding_test", title: "Acceptance", idempotencyKey: "acceptance:x" });
  await state.cancelTask(rerun.id, { by: "test" });
  const second = await state.enqueueTask({ system: "builder", kind: "model.coding_test", title: "Acceptance", idempotencyKey: "acceptance:x" });
  assert.notEqual(second.id, rerun.id, "an on-demand test may run again once the last one finished");
  await state.cancelTask(second.id, { by: "test" });
});
