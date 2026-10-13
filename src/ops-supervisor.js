import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, chmod } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertProductionStore, storeKind } from "./store.js";
import {
  PROCESS_STATUS,
  SYSTEMS,
  SYSTEM_IDS,
  TASK_STATUS,
  heartbeatThresholds,
  redactText
} from "./ops-domain.js";
import {
  acceptControlRequests,
  acquireProcessLease,
  cancelTask,
  claimTask,
  completeTask,
  emergencyState,
  failTask,
  getSystemState,
  getTask,
  latestCheckpoint,
  logEvent,
  markTaskRunning,
  parkTask,
  releaseProcessLease,
  renewTaskLease,
  resolveControlRequest,
  setSystemMode,
  updateTaskProgress,
  writeHeartbeat,
  writeOpsCheckpoint
} from "./ops-state.js";
import { transact } from "./store.js";

// One supervisor process per system. System A (builder) and System B (auditor)
// run this same runtime as two separate OS processes — separate systemd units,
// separate Unix users, separate environment files, separate workspaces and log
// files — with different handlers and different permissions.
//
// The loop never blocks on a task: a task runs beside it, so heartbeats and
// control requests keep flowing during a twenty-minute test run. That is what
// makes Pause and Stop Current Task real: the loop sees the request while the
// task is still running and aborts it.

export class TaskParked extends Error {
  constructor(status, waitingFor, recheckMs = 60_000) {
    super("Task parked: " + status);
    this.parked = { status, waitingFor, recheckMs };
  }
}

export class NonRetryableError extends Error {
  constructor(message) {
    super(message);
    this.retryable = false;
  }
}

// Secrets that belong to exactly one system. A process that can see the other
// system's secret refuses to start: isolation is checked, not assumed.
const FORBIDDEN_ENV = {
  builder: ["RAZEKIT_AUDITOR_TOKEN", "RAZEKIT_ADMIN_TOKEN", "RAZEKIT_BOOTSTRAP_TOKEN", "AWS_SECRET_ACCESS_KEY"],
  auditor: ["RAZEKIT_BUILDER_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "RAZEKIT_ADMIN_TOKEN", "RAZEKIT_BOOTSTRAP_TOKEN", "AWS_SECRET_ACCESS_KEY"]
};

export function assertIsolation(system, env = process.env) {
  const leaked = (FORBIDDEN_ENV[system] || []).filter(name => env[name]);
  if (leaked.length) {
    throw new Error("Permission isolation violated: the " + system + " process can see " + leaked.join(", ") + ". Give each system its own environment file.");
  }
}

export class Supervisor {
  constructor({
    system,
    handlers,
    env = process.env,
    processId = system + "-" + os.hostname() + "-" + process.pid + "-" + randomUUID().slice(0, 8),
    leaseMs = Number(env.RAZEKIT_OPS_TASK_LEASE_MS || 90_000),
    pollMs = Number(env.RAZEKIT_OPS_POLL_MS || 3000),
    periodic = null,
    context = {}
  }) {
    if (!SYSTEMS[system]) throw new Error("Unknown system: " + system);
    this.system = system;
    this.handlers = handlers;
    this.env = env;
    this.processId = processId;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.periodic = periodic;
    this.context = context;
    this.mode = "running";
    this.status = PROCESS_STATUS.STARTING;
    this.statusReason = null;
    this.current = null; // { task, controller, abortReason, pendingControls[] , promise }
    this.startedAt = new Date().toISOString();
    this.lastHeartbeatAt = 0;
    this.hasLease = false;
    this.workspaceRoot = path.resolve(env.RAZEKIT_OPS_WORKSPACE_ROOT || "data/ops-workspaces", system);
    this.logFile = path.resolve(env.RAZEKIT_OPS_LOG_DIR || "data/ops-logs", system + ".log");
  }

  async log(severity, action, message, { taskId = null, data = null, result = null } = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), system: this.system, processId: this.processId, severity, action, taskId, message: redactText(message) }) + "\n";
    await appendFile(this.logFile, line).catch(() => {});
    await logEvent({ source: this.system, severity, action, taskId, message, data, result }).catch(() => {});
  }

  async heartbeat() {
    const thresholds = heartbeatThresholds(this.env);
    const task = this.current?.task;
    await writeHeartbeat(this.system, {
      processId: this.processId,
      processStartedAt: this.startedAt,
      host: os.hostname(),
      pid: process.pid,
      status: this.status,
      statusReason: this.statusReason,
      mode: this.mode,
      currentTaskId: task?.id || null,
      currentTaskTitle: task?.title || null,
      intervalMs: thresholds.intervalMs,
      store: storeKind(),
      resources: {
        loadavg: os.loadavg(),
        freeMemBytes: os.freemem(),
        totalMemBytes: os.totalmem(),
        rssBytes: process.memoryUsage().rss,
        uptimeSec: Math.round(process.uptime())
      }
    });
    this.lastHeartbeatAt = Date.now();
  }

  async boot() {
    assertIsolation(this.system, this.env);
    if (storeKind() !== "postgres" && this.env.RAZEKIT_OPS_ALLOW_JSON_STORE !== "true") {
      // The file store is per-process; a supervisor beside a server on it
      // would be supervising a private copy of reality.
      assertProductionStore();
    }
    await mkdir(this.workspaceRoot, { recursive: true });
    await chmod(this.workspaceRoot, 0o700).catch(() => {});
    await mkdir(path.dirname(this.logFile), { recursive: true });
    const state = await getSystemState(this.system);
    this.mode = state.mode || "running";
  }

  async ensureLease() {
    const lease = await acquireProcessLease(this.system, this.processId, Math.max(this.leaseMs, heartbeatThresholds(this.env).offlineAfterMs));
    if (!lease.acquired) {
      if (this.hasLease) await this.log("error", "process.lease_lost", "Another process (" + lease.owner + ") holds the " + this.system + " lease; standing down");
      this.hasLease = false;
      return false;
    }
    if (!this.hasLease) await this.log("info", "process.lease_acquired", "Process " + this.processId + " owns " + SYSTEMS[this.system].name + " (mode " + this.mode + ")");
    this.hasLease = true;
    return true;
  }

  async handleControls() {
    const requests = await acceptControlRequests("system", this.system, this.processId);
    for (const request of requests) {
      try {
        await this.applyControl(request);
      } catch (error) {
        await resolveControlRequest(request.id, { status: "failed", error: error.message });
        await this.log("error", "control.failed", request.action + ": " + error.message);
      }
    }
  }

  async applyControl(request) {
    const by = request.requestedBy + " via " + request.id;
    switch (request.action) {
      case "start":
      case "resume": {
        const was = this.mode;
        await setSystemMode(this.system, "running", by);
        this.mode = "running";
        this.status = PROCESS_STATUS.RUNNING;
        await this.log("warn", "control." + request.action, SYSTEMS[this.system].name + " " + was + " -> running (" + by + ")");
        await this.heartbeat();
        return resolveControlRequest(request.id, { status: "completed", evidence: { previousMode: was, mode: "running", processId: this.processId, pid: process.pid } });
      }
      case "pause": {
        await setSystemMode(this.system, "paused", by);
        this.mode = "paused";
        this.status = PROCESS_STATUS.PAUSED;
        await this.log("warn", "control.pause", SYSTEMS[this.system].name + " paused (" + by + ")");
        if (this.current) {
          // Completed only once the running task has actually stopped.
          this.current.pendingControls.push(request);
          this.abortCurrent("pause");
          return null;
        }
        await this.heartbeat();
        return resolveControlRequest(request.id, { status: "completed", evidence: { mode: "paused", processId: this.processId, interruptedTask: null } });
      }
      case "stop_task": {
        const taskId = request.payload?.taskId;
        if (!taskId) throw new Error("stop_task needs a taskId");
        if (this.current?.task.id === taskId) {
          this.current.pendingControls.push(request);
          this.current.stopRequestedBy = by;
          this.abortCurrent("stop");
          return null;
        }
        const task = await getTask(taskId);
        if (!task || task.system !== this.system) throw new Error("Task " + taskId + " does not belong to " + this.system);
        const cancelled = await cancelTask(taskId, { by, reason: "Stopped by administrator" });
        return resolveControlRequest(request.id, { status: "completed", evidence: { taskId, finalStatus: cancelled.status, wasRunning: false } });
      }
      default:
        throw new Error("Unsupported action: " + request.action);
    }
  }

  abortCurrent(reason) {
    if (!this.current || this.current.abortReason) return;
    this.current.abortReason = reason;
    this.current.controller.abort(new Error("Aborted: " + reason));
    this.status = reason === "stop" ? PROCESS_STATUS.STOPPING : this.status;
  }

  async runTask(task) {
    const controller = new AbortController();
    this.current = { task, controller, abortReason: null, pendingControls: [] };
    const timeout = setTimeout(() => this.abortCurrent("timeout"), task.timeoutMs);
    const renew = setInterval(() => {
      renewTaskLease(task.id, this.processId, { leaseMs: this.leaseMs })
        .then(renewed => {
          // Losing a lease while still running the task means another process
          // may take it over: stop rather than work on in parallel.
          if (!renewed && this.current?.task.id === task.id && !this.current.abortReason) {
            this.log("error", "task.lease_lost", "Lease on " + task.id + " was lost; stopping this run", { taskId: task.id });
            this.abortCurrent("lease_lost");
          }
        })
        .catch(error => this.log("warn", "task.lease_renew_failed", error.message, { taskId: task.id }));
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    let outcome = "unknown";
    try {
      await markTaskRunning(task.id, this.processId);
      const checkpoint = await latestCheckpoint(task.id);
      const ctx = {
        task,
        checkpoint,
        signal: controller.signal,
        system: this.system,
        processId: this.processId,
        workspace: path.join(this.workspaceRoot, task.id),
        workspaceRoot: this.workspaceRoot,
        env: this.env,
        ...this.context,
        progress: (pct, step) => updateTaskProgress(task.id, this.processId, { pct, step }),
        checkpointWrite: (step, data) => writeOpsCheckpoint({ system: this.system, taskId: task.id, step, data }),
        log: (severity, action, message, data) => this.log(severity, action, message, { taskId: task.id, data }),
        throwIfAborted: () => { if (controller.signal.aborted) throw controller.signal.reason; }
      };
      const result = await this.handlers.run(ctx);
      if (controller.signal.aborted) throw controller.signal.reason;
      await completeTask(task.id, this.processId, result);
      outcome = "completed";
    } catch (error) {
      const reason = this.current.abortReason;
      if (error?.parked && !reason) {
        await parkTask(task.id, this.processId, error.parked);
        outcome = error.parked.status;
      } else if (reason === "lease_lost") {
        // The task is no longer ours to finish or fail; whoever holds it now does.
        outcome = "abandoned:lease_lost";
      } else if (reason === "stop") {
        await cancelTask(task.id, { by: this.current.stopRequestedBy || "administrator", reason: "Stopped by administrator" });
        outcome = "cancelled";
      } else if (reason === "pause" || reason === "emergency" || reason === "shutdown") {
        // Not the task's fault: back to the queue with the attempt refunded,
        // to resume from its last checkpoint.
        await transact(db => {
          const row = db.opsTasks.find(item => item.id === task.id);
          if (row && row.leaseOwner === this.processId) {
            row.status = TASK_STATUS.QUEUED;
            row.attempts = Math.max(0, row.attempts - 1);
            row.leaseOwner = null;
            row.leaseExpiresAt = null;
            row.availableAt = new Date().toISOString();
            row.progress = { ...(row.progress || {}), step: "interrupted by " + reason };
          }
        });
        outcome = "requeued:" + reason;
      } else {
        const message = reason === "timeout" ? "Task exceeded its " + Math.round(task.timeoutMs / 1000) + "s timeout" : (error?.message || String(error));
        await failTask(task.id, this.processId, new Error(message), { retryable: error?.retryable !== false });
        outcome = "failed";
      }
      await this.log(outcome === "failed" ? "error" : "warn", "task." + outcome.split(":")[0], (error?.message || String(error)).slice(0, 1000), { taskId: task.id });
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      const finished = await getTask(task.id).catch(() => null);
      for (const request of this.current.pendingControls) {
        await resolveControlRequest(request.id, {
          status: "completed",
          evidence: { taskId: task.id, finalStatus: finished?.status || null, outcome, mode: this.mode, processId: this.processId }
        }).catch(() => {});
      }
      this.current = null;
      if (this.status === PROCESS_STATUS.STOPPING) this.status = this.mode === "paused" ? PROCESS_STATUS.PAUSED : PROCESS_STATUS.RUNNING;
    }
    return outcome;
  }

  async tick() {
    if (!(await this.ensureLease())) return { standby: true };
    await this.handleControls();
    const emergency = await emergencyState();
    if (emergency.engaged) {
      if (this.current) this.abortCurrent("emergency");
      this.status = PROCESS_STATUS.PAUSED;
      this.statusReason = "Emergency stop engaged by " + (emergency.by || "admin") + " at " + emergency.at;
    } else if (this.mode === "paused") {
      this.status = PROCESS_STATUS.PAUSED;
      this.statusReason = "Paused by administrator";
    } else if (this.status !== PROCESS_STATUS.STOPPING) {
      this.status = PROCESS_STATUS.RUNNING;
      this.statusReason = null;
    }

    if (Date.now() - this.lastHeartbeatAt >= heartbeatThresholds(this.env).intervalMs) await this.heartbeat();
    if (emergency.engaged || this.mode !== "running" || this.current) return { idle: false };

    if (os.freemem() < Number(this.env.RAZEKIT_OPS_MIN_FREE_MEM_BYTES || 128 * 1024 * 1024)) {
      this.statusReason = "Not claiming work: free memory below the configured floor";
      return { idle: true };
    }
    if (this.periodic) await this.periodic(this).catch(error => this.log("error", "periodic.failed", error.message));
    const task = await claimTask(this.system, this.processId, { leaseMs: this.leaseMs });
    if (task) {
      // runTask sets this.current synchronously, before its first await.
      const promise = this.runTask(task).catch(error => this.log("error", "task.crashed", error.message, { taskId: task.id }));
      if (this.current) this.current.promise = promise;
    }
    return { claimed: task?.id || null };
  }

  /**
   * A loop that stops completing ticks is a hung process, and a hung process
   * must not keep looking alive. The watchdog exits it — its heartbeat then
   * ages into "stale" and "offline" — and systemd starts a fresh one.
   */
  startWatchdog(limitMs = Number(this.env.RAZEKIT_OPS_WATCHDOG_MS || 5 * 60_000)) {
    this.lastTickAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - this.lastTickAt > limitMs) {
        const line = JSON.stringify({ at: new Date().toISOString(), system: this.system, processId: this.processId, severity: "critical", action: "process.watchdog", message: "No loop iteration completed in " + Math.round(limitMs / 1000) + "s; exiting for a restart" }) + "\n";
        try { appendFileSync(this.logFile, line); } catch {}
        process.exit(70);
      }
    }, Math.min(30_000, limitMs));
    timer.unref();
    return timer;
  }

  async run({ signal } = {}) {
    await this.boot();
    await this.log("info", "process.started", SYSTEMS[this.system].name + " process " + this.processId + " started on " + os.hostname());
    const watchdog = this.startWatchdog();
    while (!signal?.aborted) {
      this.lastTickAt = Date.now();
      try {
        await this.tick();
      } catch (error) {
        this.status = PROCESS_STATUS.FAILED;
        this.statusReason = error.message;
        await this.log("error", "tick.failed", error.message);
        await this.heartbeat().catch(() => {});
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
    clearInterval(watchdog);
    await this.shutdown();
  }

  async shutdown() {
    this.status = PROCESS_STATUS.STOPPING;
    if (this.current) {
      this.abortCurrent("shutdown");
      await Promise.race([this.current?.promise, new Promise(resolve => setTimeout(resolve, 20_000))]);
    }
    this.status = PROCESS_STATUS.STOPPED;
    this.statusReason = "Process shut down";
    await this.heartbeat().catch(() => {});
    await releaseProcessLease(this.system, this.processId).catch(() => {});
    await this.log("warn", "process.stopped", "Process " + this.processId + " shut down");
  }
}

export async function createSupervisor(system, options = {}) {
  if (system === SYSTEM_IDS.BUILDER) {
    const { builderHandlers } = await import("./ops-builder.js");
    return new Supervisor({ system, handlers: builderHandlers(options), ...options });
  }
  if (system === SYSTEM_IDS.AUDITOR) {
    const { auditorHandlers, scheduleAudit } = await import("./ops-auditor.js");
    return new Supervisor({ system, handlers: auditorHandlers(options), periodic: scheduleAudit, ...options });
  }
  throw new Error("Unknown system: " + system);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = process.argv.find(item => item.startsWith("--system="));
  const system = arg ? arg.split("=")[1] : process.env.RAZEKIT_OPS_SYSTEM;
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => controller.abort());
  createSupervisor(system)
    .then(supervisor => supervisor.run({ signal: controller.signal }))
    .then(() => process.exit(0), error => {
      console.error("[" + system + "] fatal: " + redactText(error.message));
      process.exit(1);
    });
}
