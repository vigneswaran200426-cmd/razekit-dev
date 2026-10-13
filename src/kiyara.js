import { loadDb } from "./store.js";
import { ROLES } from "./auth.js";
import { DISPLAY_STATUS, SYSTEMS, deriveProcessStatus, heartbeatThresholds } from "./ops-domain.js";
import { adminAudit, createControlRequest, getControlRequest } from "./ops-state.js";

// Kiyara (Kiya) — the conversational face of RazeKit DEV.
//
// She narrates and routes; she is not a worker, a model or a permission
// bypass. Every sentence she says about the platform is built from a record in
// the store, and comes back with the evidence it was built from. Every action
// she takes goes through the same protected control-request path as the admin
// page, under the caller's own identity and role, and she reports a request
// as requested until the target process itself accepts and completes it.
//
// She understands a fixed set of commands. Free conversation needs a
// configured model; she says so instead of improvising an answer.

export const KIYARA_STATES = Object.freeze({
  IDLE: "idle",
  WORKING: "working",
  APPROVAL: "approval_needed",
  COMPLETED: "completed",
  BLOCKED: "blocked"
});

const OPERATOR_ROLES = new Set([ROLES.OWNER, ROLES.ADMIN, "operator"]);
const isOperator = principal => OPERATOR_ROLES.has(principal.role);

const WAITING = new Set(["awaiting_budget", "waiting_user"]);
const ACTIVE = new Set(["analyzing", "authorized", "queued", "ready_for_agent", "running"]);
const STOPPED = new Set(["failed", "paused"]);

function ownTasks(db, principal) {
  return db.tasks
    .filter(task => (task.tenantId || "local-tenant") === principal.tenantId && task.userId === principal.userId)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

const taskEvidence = task => ({ label: "Task " + task.id, href: "/api/tasks/" + encodeURIComponent(task.id) });

function systemsView(db, now, env) {
  const thresholds = heartbeatThresholds(env);
  const heartbeats = Object.fromEntries(db.opsHeartbeats.map(row => [row.id, row]));
  const out = {};
  for (const id of ["builder", "auditor", "gateway"]) {
    const derived = deriveProcessStatus(heartbeats[id], { now, thresholds });
    out[id] = { status: derived.status, heartbeatAt: heartbeats[id]?.at || null, ageMs: derived.ageMs ?? null };
  }
  const emergency = db.opsSettings.find(item => item.id === "emergency-stop")?.value || { engaged: false };
  return { processes: out, emergency: { engaged: Boolean(emergency.engaged), by: emergency.by || null, at: emergency.at || null } };
}

/**
 * Kiyara's state, derived from the caller's own tasks (and, for owners and
 * admins, the two supervisors). Never "working" without an active task, never
 * "completed" without a completed one.
 */
export async function kiyaraState(principal, { now = Date.now(), env = process.env } = {}) {
  const db = await loadDb();
  const tasks = ownTasks(db, principal);
  const waiting = tasks.filter(task => WAITING.has(task.status));
  const active = tasks.filter(task => ACTIVE.has(task.status));
  const stopped = tasks.filter(task => STOPPED.has(task.status));
  const latest = tasks[0] || null;
  let state = KIYARA_STATES.IDLE;
  let focus = null;
  if (waiting.length) { state = KIYARA_STATES.APPROVAL; focus = waiting[0]; }
  else if (active.length) { state = KIYARA_STATES.WORKING; focus = active[0]; }
  else if (latest && STOPPED.has(latest.status)) { state = KIYARA_STATES.BLOCKED; focus = latest; }
  else if (latest && latest.status === "completed") { state = KIYARA_STATES.COMPLETED; focus = latest; }
  const view = {
    state,
    focus: focus ? { id: focus.id, title: focus.title, status: focus.status, updatedAt: focus.updatedAt || focus.createdAt } : null,
    counts: { waiting: waiting.length, active: active.length, stopped: stopped.length, total: tasks.length },
    voice: { available: false, reason: "No speech pipeline is configured; Kiyara is text-only." },
    evidence: focus ? [taskEvidence(focus)] : [],
    observedAt: new Date(now).toISOString()
  };
  if (isOperator(principal)) {
    view.systems = systemsView(db, now, env);
    view.evidence.push({ label: "Admin Control Center", href: "/admin/24-7" });
  }
  return view;
}

const HELP = [
  "status — what is happening right now, from the live records",
  "my tasks — your missions and where each one stands",
  "pause / resume System A or System B — owners and admins (asks you to confirm)",
  "pause / resume Niomi or Konami — owners and admins (asks you to confirm)",
  "help — this list"
];

const ago = ms => ms == null ? "never" : ms < 90_000 ? Math.round(ms / 1000) + "s ago" : Math.round(ms / 60_000) + " min ago";

function describeSystem(id, process) {
  const name = id === "gateway" ? "The model gateway" : SYSTEMS[id]?.name || id;
  if (process.status === DISPLAY_STATUS.NOT_CONFIGURED) return name + " has never reported (not configured).";
  return name + " is " + process.status + " (last heartbeat " + ago(process.ageMs) + ").";
}

function statusReply(view) {
  const lines = [];
  if (view.state === KIYARA_STATES.APPROVAL) lines.push("“" + view.focus.title + "” is waiting for your decision (" + view.focus.status.replace(/_/g, " ") + ").");
  else if (view.state === KIYARA_STATES.WORKING) lines.push("I'm following “" + view.focus.title + "”: it is " + view.focus.status.replace(/_/g, " ") + ".");
  else if (view.state === KIYARA_STATES.BLOCKED) lines.push("“" + view.focus.title + "” stopped: it is " + view.focus.status + ". Open it to see why.");
  else if (view.state === KIYARA_STATES.COMPLETED) lines.push("Your latest mission, “" + view.focus.title + "”, is completed.");
  else lines.push(view.counts.total ? "Nothing of yours is running right now." : "You have no missions yet.");
  if (view.counts.total > 1) lines.push("In total: " + view.counts.active + " active, " + view.counts.waiting + " waiting for you, " + view.counts.stopped + " stopped.");
  if (view.systems) {
    if (view.systems.emergency.engaged) lines.push("The emergency stop is engaged (by " + view.systems.emergency.by + ").");
    for (const id of ["builder", "auditor", "gateway"]) lines.push(describeSystem(id, view.systems.processes[id]));
  }
  return lines.join(" ");
}

const SYSTEM_WORDS = { "system a": "builder", "a": "builder", "builder": "builder", "system b": "auditor", "b": "auditor", "auditor": "auditor" };

/** Reads a message into an intent. Deliberately small and literal. */
export function parseIntent(text) {
  const value = String(text || "").trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!value) return { intent: "empty" };
  if (/^(help|what can you do|commands?)$/.test(value)) return { intent: "help" };
  if (/^(status|what'?s happening|how (is|are) (everything|things)( going)?|update)$/.test(value)) return { intent: "status" };
  if (/^(my )?(tasks|missions)$/.test(value)) return { intent: "tasks" };
  let m = value.match(/^(pause|resume) (system a|system b|builder|auditor)$/);
  if (m) return { intent: "control", targetType: "system", target: SYSTEM_WORDS[m[2]], action: m[1] };
  m = value.match(/^(pause|resume) (niomi|konami)$/);
  if (m) return { intent: "control", targetType: "agent", target: m[2], action: m[1] };
  return { intent: "unknown" };
}

const actionLabel = (targetType, target) => targetType === "agent" ? target[0].toUpperCase() + target.slice(1) : SYSTEMS[target].name;

/**
 * One message in, one grounded reply out. Control commands come back as a
 * proposal; nothing changes until the caller confirms through executeAction.
 */
export async function handleKiyaraMessage(principal, text, options = {}) {
  const parsed = parseIntent(text);
  if (parsed.intent === "empty") return { reply: "I'm here. Ask for “status” or “help”.", intent: parsed.intent, evidence: [] };
  if (parsed.intent === "help") return { reply: "Here is what I can do:\n" + HELP.map(line => "• " + line).join("\n"), intent: "help", evidence: [] };
  if (parsed.intent === "status") {
    const view = await kiyaraState(principal, options);
    return { reply: statusReply(view), intent: "status", state: view.state, evidence: view.evidence };
  }
  if (parsed.intent === "tasks") {
    const db = await loadDb();
    const tasks = ownTasks(db, principal).slice(0, 8);
    if (!tasks.length) return { reply: "You have no missions yet.", intent: "tasks", evidence: [] };
    return {
      reply: "Your missions, newest first:\n" + tasks.map(task => "• " + task.title + " — " + String(task.status).replace(/_/g, " ")).join("\n"),
      intent: "tasks",
      evidence: tasks.map(taskEvidence)
    };
  }
  if (parsed.intent === "control") {
    if (!isOperator(principal)) {
      return { reply: "Only owners and administrators can " + parsed.action + " " + actionLabel(parsed.targetType, parsed.target) + ". Your account can't, so I haven't asked for it.", intent: "control", refused: true, evidence: [] };
    }
    // Say up front when nothing is there to act on the request.
    let caveat = "";
    if (parsed.targetType === "system") {
      const proc = systemsView(await loadDb(), options.now ?? Date.now(), options.env ?? process.env).processes[parsed.target];
      if (![DISPLAY_STATUS.RUNNING, DISPLAY_STATUS.PAUSED, DISPLAY_STATUS.STARTING, DISPLAY_STATUS.STOPPING].includes(proc.status)) {
        caveat = " Note: " + actionLabel(parsed.targetType, parsed.target) + " is " + proc.status.replace(/_/g, " ") + ", so no process is there to accept it and the request will expire unless one starts.";
      }
    }
    return {
      reply: "Do you want me to " + parsed.action + " " + actionLabel(parsed.targetType, parsed.target) + "? Nothing changes until you confirm." + caveat,
      intent: "control",
      proposal: { targetType: parsed.targetType, target: parsed.target, action: parsed.action },
      evidence: []
    };
  }
  return {
    reply: "I don't understand that yet. I follow a fixed set of commands; open conversation needs a configured model, and none is assigned to me. Try “help”.",
    intent: "unknown",
    evidence: []
  };
}

/** A confirmed command: the same durable control request the admin page makes. */
export async function executeKiyaraAction(principal, { targetType, target, action, confirm }) {
  if (!isOperator(principal)) {
    const error = new Error("Only owners and administrators can control the systems and agents");
    error.status = 403;
    throw error;
  }
  const allowed = (targetType === "system" && ["builder", "auditor"].includes(target)) || (targetType === "agent" && ["niomi", "konami"].includes(target));
  if (!allowed || !["pause", "resume"].includes(action)) {
    const error = new Error("Kiyara can only pause or resume System A, System B, Niomi or Konami");
    error.status = 400;
    throw error;
  }
  if (confirm !== true) {
    const error = new Error("Confirmation required");
    error.status = 409;
    throw error;
  }
  const actor = principal.role === "operator" ? "operator-token" : principal.email || principal.userId;
  const request = await createControlRequest({ targetType, target, action, requestedBy: "kiyara for " + actor });
  await adminAudit({ actor, actorRole: principal.role, action: (targetType === "agent" ? "agent." : "system.") + action, target, outcome: "accepted", details: { via: "kiyara", request: request.id }, requestId: principal.requestId });
  return {
    request: { id: request.id, status: request.status, targetType, target, action, requestedAt: request.requestedAt },
    reply: "Requested. " + actionLabel(targetType, target) + " has not accepted it yet; I'll tell you when its process confirms."
  };
}

/** Narrates a control request from its stored state, never ahead of it. */
export async function describeControlRequest(principal, requestId) {
  if (!isOperator(principal)) {
    const error = new Error("Only owners and administrators can follow control requests");
    error.status = 403;
    throw error;
  }
  const request = await getControlRequest(requestId);
  if (!request) {
    const error = new Error("Control request not found");
    error.status = 404;
    throw error;
  }
  const name = actionLabel(request.targetType, request.target);
  const expired = request.status === "requested" && request.expiresAt && Date.parse(request.expiresAt) < Date.now();
  const reply = expired ? "Nobody accepted the " + request.action + " request for " + name + " in time: no live process picked it up."
    : request.status === "requested" ? name + " has not accepted the " + request.action + " request yet."
    : request.status === "accepted" ? name + " accepted the " + request.action + " request (" + (request.acceptedBy || "its process") + ") and is applying it."
    : request.status === "completed" ? name + " confirmed: " + request.action + " is done."
    : name + " could not " + request.action + ": " + (request.error || request.status) + ".";
  return { request: { id: request.id, status: expired ? "expired" : request.status, acceptedBy: request.acceptedBy || null, completedAt: request.completedAt || null }, reply };
}
