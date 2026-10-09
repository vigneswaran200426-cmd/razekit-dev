import { id, loadDb, transact } from "./store.js";
import {
  ACTIVE_TASK_STATUSES,
  CONTROL_STATUS,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL_ASSIGNMENTS,
  MODEL_SLOTS,
  OPS_SOURCES,
  SYSTEM_IDS,
  TASK_STATUS,
  TERMINAL_TASK_STATUSES,
  backoffMs,
  controlRequestTtlMs,
  redactText,
  redactValue,
  validateModelId,
  BUILDER_SCOPE_AREAS
} from "./ops-domain.js";

// Durable state for the two supervisory systems, the inference gateway and the
// admin controls. Everything goes through the engine's store (transact/loadDb),
// so the same code runs on the JSON file in tests and on Neon in production.
//
// Isolation is by key, enforced here: a claim only ever returns rows for the
// system that asked, and a process lease makes a second copy of the same system
// stand down instead of working the same queue twice.

const EVENT_RETENTION = Number(process.env.RAZEKIT_OPS_EVENT_RETENTION || 3000);
const AUDIT_RETENTION = Number(process.env.RAZEKIT_OPS_AUDIT_RETENTION || 5000);
const INFERENCE_RETENTION = Number(process.env.RAZEKIT_OPS_INFERENCE_RETENTION || 500);
const CHECKPOINT_RETENTION_PER_TASK = 20;
const nowIso = (now = Date.now()) => new Date(now).toISOString();

function assertSystem(system) {
  if (!Object.values(SYSTEM_IDS).includes(system)) throw new Error("Unknown system: " + system);
}

function trimOldest(rows, max) {
  if (rows.length > max) rows.splice(0, rows.length - max);
}

// ── Events (logs) ───────────────────────────────────────────────────────────

export function buildEvent({ source, severity = "info", taskId = null, action, result = null, message = "", data = null, at = nowIso() }) {
  if (!OPS_SOURCES.includes(source)) throw new Error("Unknown log source: " + source);
  if (!["debug", "info", "warn", "error", "critical"].includes(severity)) throw new Error("Unknown severity: " + severity);
  return {
    id: id("opsevt"),
    source,
    severity,
    taskId,
    action: String(action || "event"),
    result,
    message: redactText(message).slice(0, 4000),
    data: data == null ? null : redactValue(data),
    at
  };
}

export function pushEvent(db, event) {
  db.opsEvents.push(buildEvent(event));
  trimOldest(db.opsEvents, EVENT_RETENTION);
}

export function logEvent(event) {
  return transact(db => {
    const entry = buildEvent(event);
    db.opsEvents.push(entry);
    trimOldest(db.opsEvents, EVENT_RETENTION);
    return entry;
  });
}

export async function listEvents({ source = null, severity = null, taskId = null, limit = 200, since = null } = {}) {
  const db = await loadDb();
  const order = ["debug", "info", "warn", "error", "critical"];
  const minLevel = severity ? order.indexOf(severity) : -1;
  return db.opsEvents
    .filter(event => !source || event.source === source)
    .filter(event => minLevel < 0 || order.indexOf(event.severity) >= minLevel)
    .filter(event => !taskId || event.taskId === taskId)
    .filter(event => !since || event.at > since)
    .slice(-Math.min(1000, Math.max(1, limit)))
    .reverse();
}

// ── Admin audit trail ───────────────────────────────────────────────────────

export function adminAudit({ actor, actorRole = null, action, target = null, outcome = "success", details = null, requestId = null }) {
  return transact(db => {
    const entry = {
      id: id("opsaudit"),
      actor: String(actor || "unknown"),
      actorRole,
      action,
      target,
      outcome,
      details: details == null ? null : redactValue(details),
      requestId,
      at: nowIso()
    };
    db.opsAdminAudit.push(entry);
    trimOldest(db.opsAdminAudit, AUDIT_RETENTION);
    return entry;
  });
}

export async function listAdminAudit({ limit = 200 } = {}) {
  const db = await loadDb();
  return db.opsAdminAudit.slice(-Math.min(1000, limit)).reverse();
}

// ── Heartbeats and process leases ───────────────────────────────────────────

/**
 * Records a process's heartbeat. One row per source; the processId inside it
 * says which process wrote it, so a restarted process is distinguishable from
 * the one it replaced.
 */
export function writeHeartbeat(source, report, now = Date.now()) {
  if (!OPS_SOURCES.includes(source)) throw new Error("Unknown heartbeat source: " + source);
  return transact(db => {
    let row = db.opsHeartbeats.find(item => item.id === source);
    if (!row) {
      row = { id: source, source, firstSeenAt: nowIso(now) };
      db.opsHeartbeats.push(row);
    }
    const startedAt = row.processId === report.processId ? row.processStartedAt : nowIso(now);
    Object.assign(row, redactValue({ ...report }), {
      id: source,
      source,
      processStartedAt: report.processStartedAt || startedAt,
      at: nowIso(now)
    });
    return { ...row };
  });
}

export async function getHeartbeats() {
  const db = await loadDb();
  return Object.fromEntries(db.opsHeartbeats.map(row => [row.id, row]));
}

/**
 * One live process per system. A second copy started by mistake (two systemd
 * units, a manual run beside the service) stands down instead of claiming the
 * same queue: duplicate work is prevented at the process level as well as the
 * task level.
 */
export function acquireProcessLease(system, processId, ttlMs, now = Date.now()) {
  return transact(db => {
    const state = ensureSystemState(db, system);
    const expires = Date.parse(state.processLeaseExpiresAt || 0);
    if (state.processLeaseOwner && state.processLeaseOwner !== processId && expires > now) {
      return { acquired: false, owner: state.processLeaseOwner, expiresAt: state.processLeaseExpiresAt };
    }
    state.processLeaseOwner = processId;
    state.processLeaseExpiresAt = nowIso(now + ttlMs);
    return { acquired: true, mode: state.mode };
  });
}

export function releaseProcessLease(system, processId) {
  return transact(db => {
    const state = ensureSystemState(db, system);
    if (state.processLeaseOwner === processId) {
      state.processLeaseOwner = null;
      state.processLeaseExpiresAt = null;
    }
    return true;
  });
}

function ensureSystemState(db, system) {
  let state = db.opsSystemStates.find(item => item.id === system);
  if (!state) {
    state = { id: system, mode: "running", modeChangedAt: null, modeChangedBy: null, processLeaseOwner: null, processLeaseExpiresAt: null };
    db.opsSystemStates.push(state);
  }
  return state;
}

export async function getSystemState(system) {
  const db = await loadDb();
  return db.opsSystemStates.find(item => item.id === system) || { id: system, mode: "running", modeChangedAt: null };
}

/** The mode a system process has applied. Written by that process, read on restart. */
export function setSystemMode(system, mode, by) {
  assertSystem(system);
  if (!["running", "paused"].includes(mode)) throw new Error("Unknown mode: " + mode);
  return transact(db => {
    const state = ensureSystemState(db, system);
    state.mode = mode;
    state.modeChangedAt = nowIso();
    state.modeChangedBy = by;
    return { ...state };
  });
}

// ── Emergency stop and settings ─────────────────────────────────────────────

export async function getSetting(key, fallback = null) {
  const db = await loadDb();
  return db.opsSettings.find(item => item.id === key)?.value ?? fallback;
}

export function setSetting(key, value, by) {
  return transact(db => {
    let row = db.opsSettings.find(item => item.id === key);
    if (!row) {
      row = { id: key };
      db.opsSettings.push(row);
    }
    row.value = value;
    row.updatedAt = nowIso();
    row.updatedBy = by;
    return { ...row };
  });
}

export async function emergencyState() {
  return (await getSetting("emergency-stop", null)) || { engaged: false };
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export function enqueueTask({
  system,
  kind,
  title,
  goal = "",
  scopeArea = null,
  input = {},
  priority = 5,
  idempotencyKey = null,
  maxAttempts = 3,
  timeoutMs = 30 * 60_000,
  origin = { type: "admin" },
  requestedBy = null,
  // "active": one live task per key (a re-run is allowed once it finishes).
  // "all": once per key, ever — for schedule slots, which must not re-run.
  dedupeScope = "active"
}, now = Date.now()) {
  assertSystem(system);
  if (!kind || !/^[a-z][a-z0-9._-]{1,63}$/.test(kind)) throw new Error("Task kind is required");
  if (!title || String(title).trim().length < 3) throw new Error("Task title is required");
  if (system === SYSTEM_IDS.BUILDER && scopeArea && !BUILDER_SCOPE_AREAS[scopeArea]) {
    throw new Error("System A tasks must name one of its seven scope areas");
  }
  return transact(db => {
    if (idempotencyKey) {
      const existing = db.opsTasks.find(task =>
        task.system === system && task.idempotencyKey === idempotencyKey &&
        (dedupeScope === "all" || ACTIVE_TASK_STATUSES.includes(task.status)));
      if (existing) return { ...existing, deduplicated: true };
    }
    const task = {
      id: id("opstask"),
      system,
      kind,
      title: String(title).trim().slice(0, 200),
      goal: String(goal || "").slice(0, 8000),
      scopeArea,
      input: redactValue(input),
      priority: Math.max(0, Math.min(9, Number(priority) || 5)),
      idempotencyKey,
      status: TASK_STATUS.QUEUED,
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Number(maxAttempts) || 3)),
      timeoutMs: Math.max(1000, Math.min(6 * 3600_000, Number(timeoutMs) || 30 * 60_000)),
      availableAt: nowIso(now),
      leaseOwner: null,
      leaseExpiresAt: null,
      progress: { pct: 0, step: "queued" },
      waitingFor: null,
      origin,
      requestedBy,
      result: null,
      error: null,
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      startedAt: null,
      finishedAt: null
    };
    db.opsTasks.push(task);
    pushEvent(db, { source: system, action: "task.enqueued", taskId: task.id, message: task.title, data: { kind, scopeArea, origin } });
    return { ...task };
  });
}

/**
 * Claims the next runnable task for one system. Also takes back tasks whose
 * lease expired (their process died mid-task): they return to the queue with
 * their checkpoint intact, or dead-letter once their attempts are spent.
 */
export function claimTask(system, processId, { leaseMs = 60_000, now = Date.now() } = {}) {
  assertSystem(system);
  return transact(db => {
    for (const task of db.opsTasks) {
      if (task.system !== system) continue;
      if ([TASK_STATUS.LEASED, TASK_STATUS.RUNNING].includes(task.status) && Date.parse(task.leaseExpiresAt || 0) < now) {
        recoverExpired(db, task, now);
      }
      // Parked tasks whose recheck time has come are claimable again — done
      // here, in the same transaction, to keep one round trip per claim.
      if ([TASK_STATUS.WAITING_INFERENCE, TASK_STATUS.WAITING_APPROVAL].includes(task.status) && Date.parse(task.availableAt) <= now) {
        task.status = TASK_STATUS.QUEUED;
        task.updatedAt = nowIso(now);
      }
    }
    const candidates = db.opsTasks
      .filter(task => task.system === system && task.status === TASK_STATUS.QUEUED && Date.parse(task.availableAt) <= now)
      .sort((a, b) => b.priority - a.priority || a.availableAt.localeCompare(b.availableAt));
    const task = candidates[0];
    if (!task) return null;
    task.status = TASK_STATUS.LEASED;
    task.attempts += 1;
    task.leaseOwner = processId;
    task.leaseExpiresAt = nowIso(now + leaseMs);
    task.startedAt = task.startedAt || nowIso(now);
    task.updatedAt = nowIso(now);
    task.waitingFor = null;
    pushEvent(db, { source: system, action: "task.claimed", taskId: task.id, message: "Attempt " + task.attempts + " of " + task.maxAttempts, data: { processId } });
    return { ...task };
  });
}

function recoverExpired(db, task, now) {
  const owner = task.leaseOwner;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.updatedAt = nowIso(now);
  if (task.attempts >= task.maxAttempts) {
    task.status = TASK_STATUS.DEAD_LETTER;
    task.error = "Lease expired on the final attempt (process " + owner + " stopped heartbeating)";
    task.finishedAt = nowIso(now);
    pushEvent(db, { source: task.system, severity: "error", action: "task.dead_letter", taskId: task.id, message: task.error });
  } else {
    task.status = TASK_STATUS.QUEUED;
    task.availableAt = nowIso(now);
    pushEvent(db, { source: task.system, severity: "warn", action: "task.lease_recovered", taskId: task.id, message: "Lease held by " + owner + " expired; task returned to the queue" });
  }
}

function ownedTask(db, taskId, processId) {
  const task = db.opsTasks.find(item => item.id === taskId);
  if (!task) throw new Error("Task not found");
  if (task.leaseOwner !== processId) throw new Error("Task " + taskId + " is not leased by this process");
  return task;
}

/** Extends a lease. Returns null when this process no longer holds it. */
export function renewTaskLease(taskId, processId, { leaseMs = 60_000, now = Date.now() } = {}) {
  return transact(db => {
    const task = db.opsTasks.find(item => item.id === taskId);
    if (!task || task.leaseOwner !== processId) return null;
    task.leaseExpiresAt = nowIso(now + leaseMs);
    return { ...task };
  });
}

export function markTaskRunning(taskId, processId, now = Date.now()) {
  return transact(db => {
    const task = ownedTask(db, taskId, processId);
    task.status = TASK_STATUS.RUNNING;
    task.updatedAt = nowIso(now);
    return { ...task };
  });
}

export function updateTaskProgress(taskId, processId, { pct, step }) {
  return transact(db => {
    const task = ownedTask(db, taskId, processId);
    task.progress = { pct: Math.max(0, Math.min(100, Number(pct) || 0)), step: String(step || "").slice(0, 200) };
    task.updatedAt = nowIso();
    return { ...task };
  });
}

export function completeTask(taskId, processId, result) {
  return transact(db => {
    const task = ownedTask(db, taskId, processId);
    task.status = TASK_STATUS.COMPLETED;
    task.result = redactValue(result);
    task.error = null;
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.progress = { pct: 100, step: "completed" };
    task.finishedAt = task.updatedAt = nowIso();
    pushEvent(db, { source: task.system, action: "task.completed", taskId, result: "success", message: result?.summary || task.title });
    return { ...task };
  });
}

/** A failure retries with exponential backoff until its attempts are spent. */
export function failTask(taskId, processId, error, { retryable = true, now = Date.now() } = {}) {
  return transact(db => {
    const task = ownedTask(db, taskId, processId);
    const message = redactText(error?.message || String(error)).slice(0, 4000);
    task.error = message;
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.updatedAt = nowIso(now);
    if (retryable && task.attempts < task.maxAttempts) {
      task.status = TASK_STATUS.QUEUED;
      task.availableAt = nowIso(now + backoffMs(task.attempts));
      pushEvent(db, { source: task.system, severity: "warn", action: "task.retry_scheduled", taskId, result: "retry", message: message + " — retry at " + task.availableAt });
    } else {
      task.status = retryable ? TASK_STATUS.DEAD_LETTER : TASK_STATUS.FAILED;
      task.finishedAt = nowIso(now);
      pushEvent(db, { source: task.system, severity: "error", action: "task." + task.status, taskId, result: "failure", message });
    }
    return { ...task };
  });
}

/**
 * Parks a task that cannot continue yet — waiting for inference or for an
 * approval. The lease is released, so the process is free for other work and
 * nothing claims to be running it.
 */
export function parkTask(taskId, processId, { status, waitingFor, recheckMs = 60_000, now = Date.now() }) {
  if (![TASK_STATUS.WAITING_INFERENCE, TASK_STATUS.WAITING_APPROVAL].includes(status)) throw new Error("Invalid park status");
  return transact(db => {
    const task = ownedTask(db, taskId, processId);
    task.status = status;
    task.waitingFor = waitingFor;
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.attempts = Math.max(0, task.attempts - 1);
    task.availableAt = nowIso(now + recheckMs);
    task.updatedAt = nowIso(now);
    pushEvent(db, { source: task.system, action: "task.parked", taskId, message: status + ": " + JSON.stringify(waitingFor).slice(0, 300) });
    return { ...task };
  });
}

/** Returns parked tasks whose recheck time has come back to the queue. */
export function requeueParked(system, now = Date.now()) {
  return transact(db => {
    let count = 0;
    for (const task of db.opsTasks) {
      if (task.system !== system) continue;
      if ([TASK_STATUS.WAITING_INFERENCE, TASK_STATUS.WAITING_APPROVAL].includes(task.status) && Date.parse(task.availableAt) <= now) {
        task.status = TASK_STATUS.QUEUED;
        task.updatedAt = nowIso(now);
        count += 1;
      }
    }
    return count;
  });
}

export function cancelTask(taskId, { by, reason = "Cancelled" }) {
  return transact(db => {
    const task = db.opsTasks.find(item => item.id === taskId);
    if (!task) throw new Error("Task not found");
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return { ...task, unchanged: true };
    task.status = TASK_STATUS.CANCELLED;
    task.error = reason;
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.finishedAt = task.updatedAt = nowIso();
    pushEvent(db, { source: task.system, severity: "warn", action: "task.cancelled", taskId, message: reason + " (by " + by + ")" });
    return { ...task };
  });
}

export async function getTask(taskId) {
  const db = await loadDb();
  return db.opsTasks.find(task => task.id === taskId) || null;
}

export async function listTasks({ system = null, statuses = null, limit = 100 } = {}) {
  const db = await loadDb();
  return db.opsTasks
    .filter(task => !system || task.system === system)
    .filter(task => !statuses || statuses.includes(task.status))
    .slice(-limit)
    .reverse();
}

// ── Checkpoints ─────────────────────────────────────────────────────────────

export function writeOpsCheckpoint({ system, taskId, step, data }) {
  assertSystem(system);
  return transact(db => {
    const prior = db.opsCheckpoints.filter(item => item.taskId === taskId);
    const checkpoint = {
      id: id("opsckpt"),
      system,
      taskId,
      seq: prior.length ? Math.max(...prior.map(item => item.seq)) + 1 : 1,
      step,
      data: redactValue(data),
      at: nowIso()
    };
    db.opsCheckpoints.push(checkpoint);
    if (prior.length >= CHECKPOINT_RETENTION_PER_TASK) {
      const drop = new Set(prior.slice(0, prior.length - CHECKPOINT_RETENTION_PER_TASK + 1).map(item => item.id));
      db.opsCheckpoints = db.opsCheckpoints.filter(item => !drop.has(item.id));
    }
    return checkpoint;
  });
}

export async function latestCheckpoint(taskId) {
  const db = await loadDb();
  const rows = db.opsCheckpoints.filter(item => item.taskId === taskId);
  return rows.length ? rows.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
}

export async function listCheckpoints({ system, limit = 20 }) {
  const db = await loadDb();
  return db.opsCheckpoints.filter(item => item.system === system).slice(-limit).reverse();
}

// ── Control requests ────────────────────────────────────────────────────────

/**
 * A control request is a record that a person asked for something, not proof
 * that it happened. It stays "requested" until the target process accepts it,
 * and only that process marks it completed — with evidence — or failed.
 */
export function createControlRequest({ targetType, target, action, payload = {}, requestedBy, now = Date.now() }) {
  return transact(db => {
    const request = {
      id: id("opsctl"),
      targetType,
      target,
      action,
      payload: redactValue(payload),
      status: CONTROL_STATUS.REQUESTED,
      requestedBy,
      requestedAt: nowIso(now),
      expiresAt: nowIso(now + controlRequestTtlMs()),
      acceptedAt: null,
      acceptedBy: null,
      completedAt: null,
      evidence: null,
      error: null
    };
    db.opsControlRequests.push(request);
    trimOldest(db.opsControlRequests, 2000);
    return { ...request };
  });
}

/** Accepts every pending request for this target, oldest first, and expires stale ones. */
export function acceptControlRequests(targetType, target, processId, now = Date.now()) {
  return transact(db => {
    const accepted = [];
    for (const request of db.opsControlRequests) {
      if (request.targetType !== targetType || request.target !== target) continue;
      if (request.status !== CONTROL_STATUS.REQUESTED) continue;
      if (Date.parse(request.expiresAt) < now) {
        request.status = CONTROL_STATUS.EXPIRED;
        request.error = "No live process accepted this request before it expired";
        continue;
      }
      request.status = CONTROL_STATUS.ACCEPTED;
      request.acceptedAt = nowIso(now);
      request.acceptedBy = processId;
      accepted.push({ ...request });
    }
    return accepted;
  });
}

export function resolveControlRequest(requestId, { status, evidence = null, error = null }) {
  if (![CONTROL_STATUS.COMPLETED, CONTROL_STATUS.FAILED].includes(status)) throw new Error("Invalid resolution");
  return transact(db => {
    const request = db.opsControlRequests.find(item => item.id === requestId);
    if (!request) throw new Error("Control request not found");
    request.status = status;
    request.completedAt = nowIso();
    request.evidence = evidence == null ? null : redactValue(evidence);
    request.error = error ? redactText(error) : null;
    return { ...request };
  });
}

export async function getControlRequest(requestId) {
  const db = await loadDb();
  const request = db.opsControlRequests.find(item => item.id === requestId) || null;
  if (request && request.status === CONTROL_STATUS.REQUESTED && Date.parse(request.expiresAt) < Date.now()) {
    return { ...request, status: CONTROL_STATUS.EXPIRED, error: "No live process accepted this request before it expired" };
  }
  return request;
}

export async function listControlRequests({ targetType = null, target = null, limit = 50 } = {}) {
  const db = await loadDb();
  const now = Date.now();
  return db.opsControlRequests
    .filter(item => (!targetType || item.targetType === targetType) && (!target || item.target === target))
    .slice(-limit)
    .reverse()
    .map(item => (item.status === CONTROL_STATUS.REQUESTED && Date.parse(item.expiresAt) < now
      ? { ...item, status: CONTROL_STATUS.EXPIRED }
      : item));
}

// ── Approvals ───────────────────────────────────────────────────────────────

export function createApproval({ kind, system, summary, details = {}, requestedBy, fingerprint = null }) {
  return transact(db => {
    if (fingerprint) {
      const existing = db.opsApprovals.find(item => item.fingerprint === fingerprint && item.status === "pending");
      if (existing) return { ...existing, deduplicated: true };
    }
    const approval = {
      id: id("opsappr"),
      kind,
      system,
      summary: String(summary).slice(0, 500),
      details: redactValue(details),
      fingerprint,
      status: "pending",
      requestedBy,
      requestedAt: nowIso(),
      decidedBy: null,
      decidedAt: null,
      note: null
    };
    db.opsApprovals.push(approval);
    pushEvent(db, { source: system, severity: "warn", action: "approval.requested", message: approval.summary });
    return { ...approval };
  });
}

export function decideApproval(approvalId, { decision, by, note = null }) {
  if (!["approved", "denied"].includes(decision)) throw new Error("Decision must be approved or denied");
  return transact(db => {
    const approval = db.opsApprovals.find(item => item.id === approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "pending") throw new Error("Approval was already " + approval.status);
    approval.status = decision;
    approval.decidedBy = by;
    approval.decidedAt = nowIso();
    approval.note = note ? String(note).slice(0, 1000) : null;
    return { ...approval };
  });
}

export async function listApprovals({ status = null, limit = 100 } = {}) {
  const db = await loadDb();
  return db.opsApprovals.filter(item => !status || item.status === status).slice(-limit).reverse();
}

export async function getApproval(approvalId) {
  const db = await loadDb();
  return db.opsApprovals.find(item => item.id === approvalId) || null;
}

// ── Audit findings (System B) ───────────────────────────────────────────────

export function upsertFinding(db, { fingerprint, severity, title, detail, component, recommendation = null, now = Date.now() }) {
  let finding = db.opsFindings.find(item => item.fingerprint === fingerprint && item.status === "open");
  if (finding) {
    finding.lastSeenAt = nowIso(now);
    finding.count += 1;
    finding.severity = severity;
    finding.detail = redactText(detail).slice(0, 2000);
    return finding;
  }
  finding = {
    id: id("opsfind"),
    fingerprint,
    severity,
    title,
    detail: redactText(detail).slice(0, 2000),
    component,
    recommendation,
    status: "open",
    count: 1,
    firstSeenAt: nowIso(now),
    lastSeenAt: nowIso(now),
    resolvedAt: null,
    engineeringTaskId: null
  };
  db.opsFindings.push(finding);
  trimOldest(db.opsFindings, 2000);
  return finding;
}

export function resolveMissingFindings(db, seenFingerprints, now = Date.now()) {
  const resolved = [];
  for (const finding of db.opsFindings) {
    if (finding.status === "open" && !seenFingerprints.has(finding.fingerprint)) {
      finding.status = "resolved";
      finding.resolvedAt = nowIso(now);
      resolved.push(finding.id);
    }
  }
  return resolved;
}

export async function listFindings({ status = null, limit = 100 } = {}) {
  const db = await loadDb();
  return db.opsFindings.filter(item => !status || item.status === status).slice(-limit).reverse();
}

// ── Model configuration ─────────────────────────────────────────────────────

export function defaultModelConfig() {
  return {
    id: "model-slots",
    slots: {
      coding: { model: DEFAULT_MODEL_ASSIGNMENTS.coding, contextTokens: DEFAULT_CONTEXT_TOKENS, role: "Implementation, debugging and code changes" },
      reasoning: { model: DEFAULT_MODEL_ASSIGNMENTS.reasoning, contextTokens: DEFAULT_CONTEXT_TOKENS, role: "Planning, reviewing changes and evaluating test results" }
    },
    version: 1,
    updatedAt: null,
    updatedBy: null,
    source: "default"
  };
}

export async function getModelConfig() {
  const db = await loadDb();
  return db.opsModelConfig.find(item => item.id === "model-slots") || defaultModelConfig();
}

export function setModelAssignment(slot, model, { by, contextTokens = null }) {
  if (!Object.values(MODEL_SLOTS).includes(slot)) throw new Error("Unknown model slot: " + slot);
  const validated = validateModelId(model);
  const tokens = contextTokens == null ? null : Number(contextTokens);
  if (tokens != null && (!Number.isInteger(tokens) || tokens < 2048 || tokens > 131072)) {
    throw new Error("Context tokens must be an integer between 2048 and 131072");
  }
  return transact(db => {
    let config = db.opsModelConfig.find(item => item.id === "model-slots");
    if (!config) {
      config = defaultModelConfig();
      db.opsModelConfig.push(config);
    }
    const previous = config.slots[slot].model;
    config.slots[slot] = { ...config.slots[slot], model: validated, contextTokens: tokens ?? config.slots[slot].contextTokens };
    config.version += 1;
    config.updatedAt = nowIso();
    config.updatedBy = by;
    config.source = "admin";
    pushEvent(db, { source: "admin", severity: "warn", action: "model.assignment_changed", message: slot + ": " + previous + " -> " + validated + " (by " + by + ")" });
    return { config: JSON.parse(JSON.stringify(config)), previous };
  });
}

export function writeModelStatus(status) {
  return transact(db => {
    let row = db.opsModelStatus.find(item => item.id === "gateway-models");
    if (!row) {
      row = { id: "gateway-models", models: {} };
      db.opsModelStatus.push(row);
    }
    row.checkedAt = nowIso();
    row.runtime = status.runtime;
    row.reachable = status.reachable;
    row.error = status.error ? redactText(status.error) : null;
    row.loaded = status.loaded || [];
    for (const [model, info] of Object.entries(status.models || {})) {
      row.models[model] = { ...(row.models[model] || {}), ...info };
    }
    return { ...row };
  });
}

export function recordModelTest(model, result) {
  return transact(db => {
    let row = db.opsModelStatus.find(item => item.id === "gateway-models");
    if (!row) {
      row = { id: "gateway-models", models: {} };
      db.opsModelStatus.push(row);
    }
    const prior = row.models[model] || {};
    row.models[model] = {
      ...prior,
      lastTest: { ...redactValue(result), at: nowIso() },
      lastSuccessfulTestAt: result.ok ? nowIso() : prior.lastSuccessfulTestAt || null
    };
    return row.models[model];
  });
}

export async function getModelStatus() {
  const db = await loadDb();
  return db.opsModelStatus.find(item => item.id === "gateway-models") || null;
}

// ── Inference queue ─────────────────────────────────────────────────────────

export function enqueueInference({ requester, slot, purpose, messages, tools = null, format = null, taskId = null, maxTokens = 2048 }) {
  if (!OPS_SOURCES.includes(requester)) throw new Error("Unknown requester: " + requester);
  if (!Object.values(MODEL_SLOTS).includes(slot)) throw new Error("Unknown model slot: " + slot);
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("Inference needs at least one message");
  return transact(db => {
    const request = {
      id: id("opsinf"),
      requester,
      slot,
      model: null,
      purpose: String(purpose || "inference").slice(0, 200),
      taskId,
      messages: messages.map(message => ({ ...message, content: redactText(message.content ?? "").slice(0, 60_000) })),
      tools,
      format,
      maxTokens: Math.max(16, Math.min(16384, Number(maxTokens) || 2048)),
      status: "queued",
      attempts: 0,
      createdAt: nowIso(),
      dispatchedAt: null,
      completedAt: null,
      result: null,
      usage: null,
      error: null
    };
    db.opsInferenceRequests.push(request);
    trimInference(db);
    return { ...request };
  });
}

function trimInference(db) {
  if (db.opsInferenceRequests.length <= INFERENCE_RETENTION) return;
  const finished = db.opsInferenceRequests.filter(item => ["completed", "failed", "cancelled"].includes(item.status));
  const excess = db.opsInferenceRequests.length - INFERENCE_RETENTION;
  const drop = new Set(finished.slice(0, excess).map(item => item.id));
  db.opsInferenceRequests = db.opsInferenceRequests.filter(item => !drop.has(item.id));
}

export function claimInference(gatewayId, now = Date.now()) {
  return transact(db => {
    const request = db.opsInferenceRequests.find(item => item.status === "queued");
    if (!request) return null;
    request.status = "dispatched";
    request.dispatchedAt = nowIso(now);
    request.attempts += 1;
    request.gatewayId = gatewayId;
    return JSON.parse(JSON.stringify(request));
  });
}

/** A request dispatched by a gateway that died goes back to the queue. */
export function requeueStuckInference(maxAgeMs, now = Date.now()) {
  return transact(db => {
    let count = 0;
    for (const request of db.opsInferenceRequests) {
      if (request.status === "dispatched" && Date.parse(request.dispatchedAt) < now - maxAgeMs) {
        if (request.attempts >= 3) {
          request.status = "failed";
          request.error = "Dispatched three times without a result";
          request.completedAt = nowIso(now);
        } else {
          request.status = "queued";
        }
        count += 1;
      }
    }
    return count;
  });
}

export function finishInference(requestId, { ok, model, result = null, usage = null, error = null }) {
  return transact(db => {
    const request = db.opsInferenceRequests.find(item => item.id === requestId);
    if (!request) throw new Error("Inference request not found");
    request.status = ok ? "completed" : "failed";
    request.model = model;
    request.completedAt = nowIso();
    request.result = result ? {
      content: redactText(result.content || "").slice(0, 60_000),
      toolCalls: result.toolCalls || [],
      doneReason: result.doneReason || null
    } : null;
    request.usage = usage;
    request.error = error ? redactText(error).slice(0, 2000) : null;
    if (ok && usage) recordUsage(db, { requester: request.requester, slot: request.slot, model, usage });
    return JSON.parse(JSON.stringify(request));
  });
}

function recordUsage(db, { requester, slot, model, usage }) {
  const day = new Date().toISOString().slice(0, 10);
  const key = [day, requester, slot, model].join("|");
  let row = db.opsModelUsage.find(item => item.id === key);
  if (!row) {
    row = { id: key, day, requester, slot, model, requests: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, loadDurationMs: 0 };
    db.opsModelUsage.push(row);
  }
  row.requests += 1;
  row.promptTokens += Number(usage.promptTokens || 0);
  row.completionTokens += Number(usage.completionTokens || 0);
  row.totalDurationMs += Number(usage.totalDurationMs || 0);
  row.loadDurationMs += Number(usage.loadDurationMs || 0);
  row.updatedAt = nowIso();
  trimOldest(db.opsModelUsage, 5000);
}

export async function tokensUsedToday(requester) {
  const db = await loadDb();
  const day = new Date().toISOString().slice(0, 10);
  return db.opsModelUsage
    .filter(item => item.day === day && item.requester === requester)
    .reduce((sum, item) => sum + item.promptTokens + item.completionTokens, 0);
}

export async function getInference(requestId) {
  const db = await loadDb();
  return db.opsInferenceRequests.find(item => item.id === requestId) || null;
}

export async function listInference({ limit = 50 } = {}) {
  const db = await loadDb();
  return db.opsInferenceRequests.slice(-limit).reverse().map(({ messages, tools, ...rest }) => ({ ...rest, messageCount: messages?.length || 0 }));
}

export async function listUsage({ days = 30 } = {}) {
  const db = await loadDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db.opsModelUsage.filter(item => item.day >= since);
}

// ── GPU state ───────────────────────────────────────────────────────────────

export async function getGpuState() {
  const db = await loadDb();
  return db.opsGpuState.find(item => item.id === "gpu") || null;
}

export function updateGpuState(patch) {
  return transact(db => {
    let row = db.opsGpuState.find(item => item.id === "gpu");
    if (!row) {
      row = { id: "gpu", runningMsByMonth: {} };
      db.opsGpuState.push(row);
    }
    Object.assign(row, redactValue(patch), { updatedAt: nowIso() });
    return { ...row };
  });
}

// ── Product agent controls (Niomi, Konami) ──────────────────────────────────

export async function getAgentControls() {
  const db = await loadDb();
  const out = {};
  for (const agentId of ["niomi", "konami"]) {
    out[agentId] = db.opsAgentControls.find(item => item.id === agentId) || { id: agentId, mode: "running", appliedAt: null };
  }
  return out;
}

/**
 * Applied by the runtime coordinator — the process that actually advances
 * Niomi and Konami — never by the HTTP handler. Pending requests are accepted,
 * the mode recorded, and the request completed with the coordinator as the
 * evidence that something real now behaves differently.
 */
export function applyAgentControlRequests(processId, now = Date.now()) {
  return transact(db => {
    const applied = [];
    for (const request of db.opsControlRequests) {
      if (request.targetType !== "agent" || request.status !== CONTROL_STATUS.REQUESTED) continue;
      if (Date.parse(request.expiresAt) < now) {
        request.status = CONTROL_STATUS.EXPIRED;
        continue;
      }
      let row = db.opsAgentControls.find(item => item.id === request.target);
      if (!row) {
        row = { id: request.target, mode: "running" };
        db.opsAgentControls.push(row);
      }
      row.mode = request.action === "pause" ? "paused" : "running";
      row.appliedAt = nowIso(now);
      row.appliedBy = processId;
      row.requestId = request.id;
      request.status = CONTROL_STATUS.COMPLETED;
      request.acceptedAt = request.completedAt = nowIso(now);
      request.acceptedBy = processId;
      request.evidence = { mode: row.mode, appliedBy: processId };
      pushEvent(db, { source: request.target, severity: "warn", action: "agent." + request.action, message: request.target + " " + row.mode + " by runtime coordinator " + processId });
      applied.push({ ...row });
    }
    return applied;
  });
}
