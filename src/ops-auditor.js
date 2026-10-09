import os from "node:os";
import { statfs } from "node:fs/promises";
import { loadDb, transact } from "./store.js";
import { recoverExpiredJobs, recoverExpiredWorkers } from "./reliability.js";
import { assertNetworkAccess } from "./network-policy.js";
import {
  ACTIVE_TASK_STATUSES,
  TASK_STATUS,
  deriveProcessStatus,
  heartbeatThresholds
} from "./ops-domain.js";
import {
  enqueueTask,
  getGpuState,
  pushEvent,
  requeueStuckInference,
  resolveMissingFindings,
  upsertFinding
} from "./ops-state.js";
import { gatewayConfig, gpuCostSoFar } from "./inference-gateway.js";
import { GpuController } from "./gpu-controller.js";
import { NonRetryableError } from "./ops-supervisor.js";
import { notifyAdmin } from "./ops-notify.js";

// System B — Runtime Operations and Auditor.
//
// It looks at the running platform, not at the code: heartbeats, leases,
// queues, failed jobs, the model gateway, the deployed DEV service, host
// resources and spend. Every check reads real state; a check that cannot read
// its source reports that, rather than assuming the source is fine.
//
// Repairs are limited to an explicit list of reversible operations that the
// platform already defines (lease recovery, requeueing). Anything that needs a
// code change becomes a scoped task in System A's queue; anything else that
// needs a decision becomes an approval request.

export const DEFAULT_REPAIRS = Object.freeze(["recover-expired-jobs", "recover-expired-workers", "requeue-stuck-inference"]);

function enabledRepairs(env) {
  const raw = env.RAZEKIT_AUDITOR_REPAIRS;
  if (raw == null) return new Set(DEFAULT_REPAIRS);
  return new Set(raw.split(",").map(item => item.trim()).filter(item => DEFAULT_REPAIRS.includes(item)));
}

const auditIntervalMs = env => Math.max(60_000, Number(env.RAZEKIT_AUDIT_INTERVAL_MINUTES || 5) * 60_000);

/** Enqueues one audit per interval slot; the idempotency key makes it once. */
export async function scheduleAudit(supervisor) {
  const interval = auditIntervalMs(supervisor.env);
  const slot = Math.floor(Date.now() / interval);
  await enqueueTask({
    system: "auditor",
    kind: "audit.cycle",
    title: "Runtime audit " + new Date(slot * interval).toISOString().slice(0, 16) + "Z",
    idempotencyKey: "audit:" + slot,
    dedupeScope: "all",
    maxAttempts: 2,
    timeoutMs: 5 * 60_000,
    origin: { type: "schedule" },
    priority: 6
  });
  const day = new Date().toISOString().slice(0, 10);
  if (new Date().getUTCHours() >= Number(supervisor.env.RAZEKIT_DAILY_REPORT_HOUR_UTC || 3)) {
    await enqueueTask({
      system: "auditor",
      kind: "report.daily",
      title: "Daily operations report " + day,
      idempotencyKey: "daily-report:" + day,
      dedupeScope: "all",
      maxAttempts: 3,
      origin: { type: "schedule" },
      priority: 3
    });
  }
}

async function checkDevRuntime(env) {
  const base = env.RAZEKIT_DEV_BASE_URL;
  if (!base) return { configured: false };
  const url = new URL("/health", base).toString();
  assertNetworkAccess({ defaultAction: "deny", allowedHosts: [new URL(base).hostname], allowedPorts: [443, 80, Number(new URL(base).port) || 443], denyPrivateNetworks: !/^(localhost|127\.)/.test(new URL(base).hostname) }, url);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const data = await response.json().catch(() => ({}));
    return { configured: true, url, ok: response.ok && data.ok === true, status: response.status, latencyMs: Date.now() - started, store: data.store || null, modelMode: data.models?.mode || null };
  } catch (error) {
    return { configured: true, url, ok: false, error: error.message, latencyMs: Date.now() - started };
  }
}

async function hostResources(env) {
  const out = { loadavg: os.loadavg(), cpus: os.cpus().length, freeMemBytes: os.freemem(), totalMemBytes: os.totalmem() };
  try {
    const fsStats = await statfs(env.RAZEKIT_OPS_WORKSPACE_ROOT || ".");
    out.diskFreeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
    out.diskTotalBytes = Number(fsStats.blocks) * Number(fsStats.bsize);
  } catch (error) {
    out.diskError = error.message;
  }
  return out;
}

function normaliseError(message) {
  return String(message || "unknown").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>").replace(/\b\w+_[0-9a-f-]{20,}\b/gi, "<id>").replace(/\d+/g, "N").slice(0, 160);
}

export async function runAudit(ctx) {
  const env = ctx.env;
  const now = Date.now();
  const thresholds = heartbeatThresholds(env);
  const repairs = enabledRepairs(env);
  const repairLog = [];
  const checks = {};

  // Authorized, reversible repairs — the platform's own recovery routines.
  if (repairs.has("recover-expired-jobs")) {
    const recovered = await recoverExpiredJobs();
    if (recovered.length) repairLog.push({ repair: "recover-expired-jobs", count: recovered.length });
  }
  if (repairs.has("recover-expired-workers")) {
    const recovered = await recoverExpiredWorkers();
    if (recovered.length) repairLog.push({ repair: "recover-expired-workers", count: recovered.length });
  }
  ctx.throwIfAborted();

  const db = await loadDb();
  const heartbeats = Object.fromEntries(db.opsHeartbeats.map(row => [row.id, row]));
  const builder = deriveProcessStatus(heartbeats.builder, { now, thresholds });
  const gateway = deriveProcessStatus(heartbeats.gateway, { now, thresholds });
  checks.builder = { status: builder.status, ageMs: builder.ageMs, reason: builder.reason };
  checks.gateway = { status: gateway.status, ageMs: gateway.ageMs, ollamaReachable: heartbeats.gateway?.ollamaReachable ?? null };

  if (repairs.has("requeue-stuck-inference") && gateway.status !== "running") {
    const count = await requeueStuckInference(10 * 60_000, now);
    if (count) repairLog.push({ repair: "requeue-stuck-inference", count });
  }

  const builderTasks = db.opsTasks.filter(task => task.system === "builder");
  checks.builderQueue = {
    queued: builderTasks.filter(task => task.status === TASK_STATUS.QUEUED).length,
    running: builderTasks.filter(task => [TASK_STATUS.LEASED, TASK_STATUS.RUNNING].includes(task.status)).length,
    waitingInference: builderTasks.filter(task => task.status === TASK_STATUS.WAITING_INFERENCE).length,
    deadLetter: builderTasks.filter(task => task.status === TASK_STATUS.DEAD_LETTER).length,
    expiredLeases: builderTasks.filter(task => [TASK_STATUS.LEASED, TASK_STATUS.RUNNING].includes(task.status) && Date.parse(task.leaseExpiresAt || 0) < now).length
  };
  checks.inferenceQueue = {
    queued: db.opsInferenceRequests.filter(item => item.status === "queued").length,
    dispatched: db.opsInferenceRequests.filter(item => item.status === "dispatched").length,
    oldestQueuedAt: db.opsInferenceRequests.find(item => item.status === "queued")?.createdAt || null
  };
  checks.engineJobs = {
    total: db.jobs.length,
    byStatus: db.jobs.reduce((acc, job) => ({ ...acc, [job.status]: (acc[job.status] || 0) + 1 }), {}),
    expiredLeases: db.jobs.filter(job => job.leaseExpiresAt && ["leased", "running"].includes(job.status) && Date.parse(job.leaseExpiresAt) < now).length
  };
  checks.workers = {
    production: db.productionWorkers.length,
    staleProduction: db.productionWorkers.filter(worker => worker.status !== "offline" && worker.heartbeatAt && now - Date.parse(worker.heartbeatAt) > 5 * 60_000).length
  };
  checks.graph = {
    runningNodes: db.graphNodes.filter(node => node.status === "running").length,
    expiredNodeLeases: db.graphNodes.filter(node => node.status === "running" && node.leaseExpiresAt && Date.parse(node.leaseExpiresAt) < now).length,
    openReconciliations: db.modelReconciliations.filter(item => item.status !== "resolved").length
  };
  checks.agents = ["niomi", "konami"].map(type => {
    const agents = db.agentInstances.filter(agent => agent.agentType === type);
    return { type, running: agents.filter(agent => agent.status === "running").length, failed: agents.filter(agent => agent.status === "failed").length, blocked: agents.filter(agent => agent.status === "blocked").length };
  });
  checks.devRuntime = await checkDevRuntime(env);
  checks.host = await hostResources(env);
  const gpu = await getGpuState();
  checks.spend = { gpu: gpuCostSoFar(gpu, gatewayConfig(env), now) };
  const controller = new GpuController();
  if (env.RAZEKIT_AWS_BUDGET_NAME) checks.spend.awsBudget = await controller.budget().catch(error => ({ configured: true, error: error.message }));
  ctx.throwIfAborted();

  // Findings, and the engineering tasks they turn into.
  const failureGroups = new Map();
  for (const job of db.jobs.filter(item => ["dead_letter", "failed", "blocked"].includes(item.status))) {
    const key = "job:" + (job.type || job.kind || "job") + ":" + normaliseError(job.lastError || job.error);
    failureGroups.set(key, [...(failureGroups.get(key) || []), job.id]);
  }
  for (const agent of db.agentInstances.filter(item => item.status === "failed")) {
    const terminal = db.agentMessages.filter(message => message.agentInstanceId === agent.id && message.metadata?.terminal).pop();
    const key = "agent:" + agent.agentType + ":" + normaliseError(terminal?.content);
    failureGroups.set(key, [...(failureGroups.get(key) || []), agent.id]);
  }

  const engineering = [];
  const result = await transact(async tx => {
    const seen = new Set();
    const find = (fingerprint, data) => { seen.add(fingerprint); return upsertFinding(tx, { ...data, fingerprint, now }); };
    if (builder.status !== "running" && builder.status !== "paused") {
      find("process:builder:" + builder.status, { severity: builder.status === "not_configured" ? "warn" : "error", title: "System A is " + builder.status, detail: builder.reason || "", component: "builder" });
    }
    if (gateway.status !== "running" && gateway.status !== "paused") {
      find("process:gateway:" + gateway.status, { severity: "warn", title: "Inference gateway is " + gateway.status, detail: gateway.reason || "", component: "gateway" });
    } else if (heartbeats.gateway && !heartbeats.gateway.ollamaReachable && checks.inferenceQueue.queued > 0) {
      find("inference:unavailable", { severity: "warn", title: checks.inferenceQueue.queued + " inference request(s) waiting: model server unreachable", detail: heartbeats.gateway.ollamaError || "", component: "gateway", recommendation: "Start the GPU instance or check Ollama" });
    }
    if (checks.builderQueue.expiredLeases) find("builder:expired-leases", { severity: "warn", title: checks.builderQueue.expiredLeases + " System A task lease(s) expired", detail: "They return to the queue on System A's next claim", component: "builder" });
    if (checks.builderQueue.deadLetter) find("builder:dead-letter", { severity: "error", title: checks.builderQueue.deadLetter + " System A task(s) dead-lettered", detail: "Retries exhausted; inspect the task errors", component: "builder" });
    if (checks.devRuntime.configured && !checks.devRuntime.ok) find("dev-runtime:health", { severity: "critical", title: "DEV runtime health check failed", detail: checks.devRuntime.error || "HTTP " + checks.devRuntime.status, component: "dev-runtime" });
    if (checks.graph.expiredNodeLeases) find("graph:expired-node-leases", { severity: "warn", title: checks.graph.expiredNodeLeases + " graph node lease(s) expired", detail: "Recovered by the JEV worker on its next claim", component: "jev" });
    if (checks.graph.openReconciliations) find("models:reconciliations", { severity: "warn", title: checks.graph.openReconciliations + " model call(s) need reconciliation", detail: "Provider outcome unknown; a person must resolve", component: "models" });
    if (checks.host.diskFreeBytes != null && checks.host.diskFreeBytes < 2 * 1024 ** 3) find("host:disk", { severity: "critical", title: "Control-plane disk below 2 GB free", detail: String(checks.host.diskFreeBytes), component: "host" });
    if (checks.spend.gpu.remainingUsd != null && checks.spend.gpu.budgetUsd && checks.spend.gpu.remainingUsd < checks.spend.gpu.budgetUsd * 0.2) {
      find("spend:gpu-budget", { severity: "warn", title: "GPU budget 80% used", detail: JSON.stringify(checks.spend.gpu), component: "spend" });
    }

    for (const [key, ids] of failureGroups) {
      if (ids.length < 3) continue;
      const fingerprint = "repeat-failure:" + key;
      const finding = find(fingerprint, { severity: "error", title: "Repeated failure (" + ids.length + "x): " + key.slice(0, 120), detail: "Examples: " + ids.slice(0, 5).join(", "), component: key.startsWith("agent:konami") ? "konami" : key.startsWith("agent:niomi") ? "niomi" : "dev-workflows", recommendation: "Code change needed" });
      if (!finding.engineeringTaskId) engineering.push({ finding, key, count: ids.length });
    }

    const resolved = resolveMissingFindings(tx, seen, now);
    pushEvent(tx, { source: "auditor", action: "audit.completed", result: "success", taskId: ctx.task.id, message: "Audit: " + seen.size + " open finding(s), " + resolved.length + " resolved, " + repairLog.length + " repair(s)", data: { repairs: repairLog } });
    return { open: seen.size, resolved: resolved.length };
  });

  for (const item of engineering) {
    const scopeArea = item.finding.component === "konami" ? "konami" : item.finding.component === "niomi" ? "niomi" : "dev-workflows";
    const task = await enqueueTask({
      system: "builder",
      kind: "code.change",
      scopeArea,
      title: "Fix repeated runtime failure: " + item.key.slice(0, 120),
      goal: "System B observed the same failure " + item.count + " times in the running DEV platform (" + item.key + "). Find the cause in the " + scopeArea + " code, fix it, and add a test that reproduces it. Detail: " + item.finding.detail,
      idempotencyKey: "finding:" + item.finding.id,
      origin: { type: "system-b", findingId: item.finding.id, auditTaskId: ctx.task.id },
      requestedBy: "auditor"
    });
    await transact(tx => {
      const row = tx.opsFindings.find(finding => finding.id === item.finding.id);
      if (row) row.engineeringTaskId = task.id;
    });
  }

  const critical = (await loadDb()).opsFindings.filter(item => item.status === "open" && item.severity === "critical" && !item.notifiedAt);
  for (const finding of critical) {
    const sent = await notifyAdmin({ subject: "[RazeKit DEV] " + finding.title, text: finding.detail || finding.title, kind: "alert" }, ctx.env);
    await transact(tx => {
      const row = tx.opsFindings.find(item => item.id === finding.id);
      if (row) { row.notifiedAt = new Date().toISOString(); row.notification = sent; }
    });
  }

  return {
    summary: "Audit complete: " + result.open + " open finding(s), " + result.resolved + " resolved, " + repairLog.length + " repair(s), " + engineering.length + " engineering task(s) filed",
    checks,
    repairs: repairLog,
    engineeringTasks: engineering.length,
    auditedAt: new Date(now).toISOString()
  };
}

async function dailyReport(ctx) {
  const db = await loadDb();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const tasks = db.opsTasks.filter(task => task.updatedAt >= since);
  const usage = db.opsModelUsage.filter(row => row.day >= since.slice(0, 10));
  const lines = [
    "RazeKit DEV operations — last 24h",
    "System A tasks: " + tasks.filter(task => task.system === "builder").map(task => task.status).join(", "),
    "System B tasks: " + tasks.filter(task => task.system === "auditor").length,
    "Open findings: " + db.opsFindings.filter(item => item.status === "open").map(item => "[" + item.severity + "] " + item.title).join("; "),
    "Model usage: " + usage.map(row => row.requester + "/" + row.slot + "/" + row.model + " " + row.requests + " req " + (row.promptTokens + row.completionTokens) + " tok").join("; ")
  ];
  const sent = await notifyAdmin({ subject: "[RazeKit DEV] Daily operations report", text: lines.join("\n"), kind: "report" }, ctx.env);
  return { summary: "Daily report " + (sent.sent ? "sent to the admin" : "recorded; not emailed (" + sent.reason + ")"), report: lines, notification: sent };
}

export function auditorHandlers() {
  return {
    async run(ctx) {
      switch (ctx.task.kind) {
        case "audit.cycle": return runAudit(ctx);
        case "report.daily": return dailyReport(ctx);
        default: throw new NonRetryableError("System B does not handle task kind " + ctx.task.kind);
      }
    }
  };
}

export const AUDITOR_TASK_KINDS = Object.freeze(["audit.cycle", "report.daily"]);
export { ACTIVE_TASK_STATUSES };
