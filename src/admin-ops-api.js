import { loadDb } from "./store.js";
import { assertOperator } from "./admin-control.js";
import { AuthError } from "./auth.js";
import {
  AGENT_ACTIONS,
  BUILDER_SCOPE_AREAS,
  DISPLAY_STATUS,
  GATEWAY_ACTIONS,
  MODEL_SLOTS,
  OPS_SOURCES,
  PRODUCT_AGENTS,
  SYSTEMS,
  SYSTEM_ACTIONS,
  TASK_STATUS,
  deriveProcessStatus,
  heartbeatThresholds,
  supportedModels
} from "./ops-domain.js";
import {
  adminAudit,
  cancelTask,
  createApproval,
  createControlRequest,
  decideApproval,
  enqueueTask,
  getApproval,
  getControlRequest,
  getInference,
  getModelConfig,
  listAdminAudit,
  listApprovals,
  listEvents,
  setModelAssignment,
  setSetting
} from "./ops-state.js";
import { enqueueModelTest, gatewayConfig, gpuCostSoFar } from "./inference-gateway.js";

// The admin control center's API. Every route here is privileged and checks
// the caller on the server — owner or admin session, or the operator token —
// before reading anything. Hiding a button is never the protection.
//
// A control endpoint records a request and returns it; it does not claim the
// thing happened. The supervised process accepts the request and completes it
// with evidence, and the page polls the request to show which of those
// actually occurred.

const BUILDER_KINDS = ["repo.inspect", "code.change", "model.coding_test", "model.reasoning_test"];
const AUDITOR_KINDS = ["audit.cycle"];

export class OpsHttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function actorOf(principal) {
  return principal.role === "operator" ? "operator-token" : (principal.email || principal.userId);
}

const pick = (obj, keys) => Object.fromEntries(keys.filter(key => obj?.[key] !== undefined).map(key => [key, obj[key]]));

function publicHeartbeat(heartbeat) {
  if (!heartbeat) return null;
  return pick(heartbeat, ["processId", "host", "pid", "status", "statusReason", "mode", "currentTaskId", "currentTaskTitle", "at", "processStartedAt", "firstSeenAt", "resources", "store", "ollamaReachable", "ollamaError", "queueDepth", "dispatched", "lastActivityAt", "gpuState", "ollamaUrlConfigured"]);
}

function taskSummary(task) {
  if (!task) return null;
  return pick(task, ["id", "system", "kind", "title", "scopeArea", "status", "attempts", "maxAttempts", "progress", "waitingFor", "origin", "requestedBy", "error", "createdAt", "updatedAt", "startedAt", "finishedAt", "availableAt", "leaseOwner", "leaseExpiresAt", "result"]);
}

function processView(heartbeat, now, thresholds) {
  const derived = deriveProcessStatus(heartbeat, { now, thresholds });
  return { ...derived, heartbeat: publicHeartbeat(heartbeat) };
}

function systemView(db, system, heartbeats, now, thresholds) {
  const tasks = db.opsTasks.filter(task => task.system === system);
  const process = processView(heartbeats[system], now, thresholds);
  const live = [DISPLAY_STATUS.RUNNING, DISPLAY_STATUS.PAUSED, DISPLAY_STATUS.STOPPING, DISPLAY_STATUS.STARTING].includes(process.status);
  const currentId = live ? heartbeats[system]?.currentTaskId : null;
  const current = currentId ? tasks.find(task => task.id === currentId) : null;
  const finished = tasks.filter(task => task.status === TASK_STATUS.COMPLETED);
  const checkpoints = db.opsCheckpoints.filter(item => item.system === system);
  const errors = db.opsEvents.filter(event => event.source === system && ["error", "critical"].includes(event.severity)).slice(-10).reverse();
  const state = db.opsSystemStates.find(item => item.id === system) || null;
  const view = {
    ...SYSTEMS[system],
    process,
    persistedMode: state?.mode || "running",
    modeChangedAt: state?.modeChangedAt || null,
    modeChangedBy: state?.modeChangedBy || null,
    currentTask: taskSummary(current),
    queue: {
      queued: tasks.filter(task => task.status === TASK_STATUS.QUEUED).length,
      running: tasks.filter(task => [TASK_STATUS.LEASED, TASK_STATUS.RUNNING].includes(task.status)).length,
      waitingInference: tasks.filter(task => task.status === TASK_STATUS.WAITING_INFERENCE).length,
      waitingApproval: tasks.filter(task => task.status === TASK_STATUS.WAITING_APPROVAL).length,
      deadLetter: tasks.filter(task => task.status === TASK_STATUS.DEAD_LETTER).length,
      failed: tasks.filter(task => task.status === TASK_STATUS.FAILED).length
    },
    queuedTasks: tasks.filter(task => [TASK_STATUS.QUEUED, TASK_STATUS.WAITING_INFERENCE, TASK_STATUS.WAITING_APPROVAL].includes(task.status))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)).slice(0, 12).map(taskSummary),
    recentTasks: tasks.slice(-15).reverse().map(taskSummary),
    lastCheckpoint: checkpoints.length ? pick(checkpoints[checkpoints.length - 1], ["id", "taskId", "seq", "step", "at"]) : null,
    lastCompleted: taskSummary(finished[finished.length - 1]),
    recentErrors: errors,
    controls: db.opsControlRequests.filter(item => item.targetType === "system" && item.target === system).slice(-8).reverse()
      .map(item => (item.status === "requested" && Date.parse(item.expiresAt) < now ? { ...item, status: "expired" } : item))
  };
  if (system === "builder") {
    const changes = finished.filter(task => task.kind === "code.change");
    const lastChange = changes[changes.length - 1];
    const inspections = finished.filter(task => task.result?.tests);
    const lastTests = [...tasks].reverse().find(task => task.result?.tests);
    const prs = tasks.filter(task => task.result?.pullRequest).reverse();
    view.lastCodeChange = lastChange ? { taskId: lastChange.id, summary: lastChange.result?.summary, commit: lastChange.result?.commit || null, branch: lastChange.result?.branch || null, at: lastChange.finishedAt } : null;
    view.lastTestResult = lastTests ? { taskId: lastTests.id, ...pick(lastTests.result.tests, ["passed", "total", "pass", "fail", "skipped", "failing", "durationMs"]), at: lastTests.finishedAt || lastTests.updatedAt } : null;
    view.lastDraftPr = prs[0] ? { taskId: prs[0].id, ...prs[0].result.pullRequest, at: prs[0].finishedAt } : null;
    view.inspections = inspections.length;
    view.scopeAreas = Object.entries(BUILDER_SCOPE_AREAS).map(([id, area]) => ({ id, label: area.label }));
  } else {
    const audits = tasks.filter(task => task.kind === "audit.cycle");
    const lastAudit = [...audits].reverse().find(task => task.status === TASK_STATUS.COMPLETED);
    view.lastSuccessfulAudit = lastAudit ? { taskId: lastAudit.id, at: lastAudit.finishedAt, summary: lastAudit.result?.summary } : null;
    view.runtimeHealth = lastAudit?.result?.checks || null;
    view.recoveryOperations = audits.filter(task => task.result?.repairs?.length).slice(-10).reverse()
      .map(task => ({ taskId: task.id, at: task.finishedAt, repairs: task.result.repairs }));
    view.recentFailures = audits.filter(task => [TASK_STATUS.FAILED, TASK_STATUS.DEAD_LETTER].includes(task.status) || task.error).slice(-8).reverse().map(taskSummary);
    view.findings = db.opsFindings.filter(item => item.status === "open").slice(-30).reverse();
    view.resolvedFindings = db.opsFindings.filter(item => item.status === "resolved").slice(-10).reverse();
    view.monitoredComponents = ["System A process", "System A task leases & queue", "Inference gateway & model server", "Inference queue", "Engine job queue & leases", "Production workers", "JEV graph node leases", "Model reconciliations", "Niomi & Konami agents", "DEV runtime /health", "Control-plane host resources", "GPU spend vs budget", "AWS budget (when configured)"];
  }
  return view;
}

function agentView(db, agentId, controls, runtime) {
  const meta = PRODUCT_AGENTS[agentId];
  const agents = db.agentInstances.filter(agent => agent.agentType === agentId);
  const taskIds = new Set(agents.map(agent => agent.taskId));
  const tasks = db.tasks.filter(task => taskIds.has(task.id) || meta.taskTypes.includes(task.taskType));
  const running = agents.filter(agent => agent.status === "running");
  const runs = db.executionRuns.filter(run => taskIds.has(run.taskId));
  const lastOk = [...runs].reverse().find(run => run.status === "completed" || run.status === "passed");
  const lastCompletedTask = [...tasks].reverse().find(task => task.status === "completed");
  const errors = [
    ...agents.filter(agent => agent.status === "failed").map(agent => {
      const terminal = db.agentMessages.filter(message => message.agentInstanceId === agent.id && message.metadata?.terminal).pop();
      return { at: agent.completedAt, agentInstanceId: agent.id, taskId: agent.taskId, message: terminal?.content || "Agent failed" };
    }),
    ...runs.filter(run => run.error).map(run => ({ at: run.completedAt || run.startedAt, taskId: run.taskId, message: String(run.error).slice(0, 300) }))
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8);
  const control = controls.find(item => item.id === agentId) || { mode: "running", appliedAt: null };
  let availability;
  if (!runtime.coordinatorEnabled) availability = { state: "unavailable", reason: "The runtime coordinator is disabled on this server (RAZEKIT_COORDINATOR_ENABLED=false)" };
  else if (!runtime.modelsConfigured) availability = { state: "unavailable", reason: "No model provider is configured for the agent loop" };
  else if (control.mode === "paused") availability = { state: "paused", reason: "Paused by administrator; the coordinator does not advance " + meta.name };
  else if (runtime.emergency) availability = { state: "paused", reason: "Emergency stop engaged" };
  else availability = { state: "available", reason: "Advanced by the runtime coordinator on this server" };
  return {
    ...meta,
    availability,
    control,
    currentWorkflow: running.map(agent => {
      const task = db.tasks.find(item => item.id === agent.taskId);
      const nodes = db.graphNodes.filter(node => node.taskId === agent.taskId && node.status === "running").map(node => node.kind || node.name || node.key || node.id);
      return { agentInstanceId: agent.id, taskId: agent.taskId, taskTitle: task?.title || null, executionState: agent.executionState || null, runningNodes: nodes.slice(0, 5) };
    }),
    assignedTasks: tasks.filter(task => ["queued", "running", "waiting_user", "ready_for_agent", "paused"].includes(task.status)).slice(-10).reverse()
      .map(task => pick(task, ["id", "title", "status", "taskType", "updatedAt"])),
    lastSuccessfulRun: lastOk ? pick(lastOk, ["id", "taskId", "kind", "status", "startedAt", "completedAt"]) : (lastCompletedTask ? { taskId: lastCompletedTask.id, kind: "task", status: "completed", completedAt: lastCompletedTask.updatedAt } : null),
    errors,
    history: tasks.slice(-12).reverse().map(task => pick(task, ["id", "title", "status", "taskType", "createdAt", "updatedAt"])),
    controlRequests: db.opsControlRequests.filter(item => item.targetType === "agent" && item.target === agentId).slice(-5).reverse()
  };
}

export async function buildDashboard({ runtime, now = Date.now(), env = process.env }) {
  const db = await loadDb();
  const thresholds = heartbeatThresholds(env);
  const heartbeats = Object.fromEntries(db.opsHeartbeats.map(row => [row.id, row]));
  const emergency = db.opsSettings.find(item => item.id === "emergency-stop")?.value || { engaged: false };
  const modelConfig = await getModelConfig();
  const modelStatus = db.opsModelStatus.find(item => item.id === "gateway-models") || null;
  const gpu = db.opsGpuState.find(item => item.id === "gpu") || null;
  const gateway = processView(heartbeats.gateway, now, thresholds);
  const config = gatewayConfig(env);
  const controls = db.opsAgentControls;
  const auditor = systemView(db, "auditor", heartbeats, now, thresholds);
  const usage = db.opsModelUsage.filter(row => row.day >= new Date(now - 30 * 86_400_000).toISOString().slice(0, 10));
  const usageBy = (field) => Object.values(usage.reduce((acc, row) => {
    const key = row[field];
    acc[key] = acc[key] || { [field]: key, requests: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0 };
    acc[key].requests += row.requests; acc[key].promptTokens += row.promptTokens; acc[key].completionTokens += row.completionTokens; acc[key].totalDurationMs += row.totalDurationMs;
    return acc;
  }, {}));
  const gatewayLive = gateway.status === DISPLAY_STATUS.RUNNING || gateway.status === DISPLAY_STATUS.PAUSED;

  return {
    generatedAt: new Date(now).toISOString(),
    thresholds,
    store: runtime.store,
    emergency,
    systems: {
      builder: systemView(db, "builder", heartbeats, now, thresholds),
      auditor
    },
    agents: {
      niomi: agentView(db, "niomi", controls, { ...runtime, emergency: emergency.engaged }),
      konami: agentView(db, "konami", controls, { ...runtime, emergency: emergency.engaged })
    },
    models: {
      config: modelConfig,
      supported: supportedModels(env),
      status: modelStatus,
      gateway,
      queue: {
        queued: db.opsInferenceRequests.filter(item => item.status === "queued").length,
        dispatched: db.opsInferenceRequests.filter(item => item.status === "dispatched").length,
        oldestQueuedAt: db.opsInferenceRequests.find(item => item.status === "queued")?.createdAt || null
      },
      lastSuccessfulInference: [...db.opsInferenceRequests].reverse().find(item => item.status === "completed")
        ? pick([...db.opsInferenceRequests].reverse().find(item => item.status === "completed"), ["id", "requester", "slot", "model", "completedAt", "usage"]) : null,
      recentRequests: db.opsInferenceRequests.slice(-15).reverse().map(item => pick(item, ["id", "requester", "slot", "model", "purpose", "status", "createdAt", "completedAt", "usage", "error"])),
      usageByRequester: usageBy("requester"),
      usageBySlot: usageBy("slot"),
      usageByModel: usageBy("model"),
      agentLoopModels: runtime.models
    },
    compute: {
      processes: ["builder", "auditor", "gateway"].map(source => ({ source, ...processView(heartbeats[source], now, thresholds) })),
      gpu: gpu ? pick(gpu, ["configured", "instanceId", "state", "instanceType", "launchTime", "privateIp", "observedAt", "checkedAt", "lastError", "lastActivityAt", "source"]) : { configured: false, state: "not_configured" },
      gpuControlsAvailable: Boolean(gatewayLive && gpu?.configured),
      gpuControlsReason: !gatewayLive ? "The inference gateway process is " + gateway.status + "; GPU start/stop is executed by that process" : (!gpu?.configured ? "No GPU instance is configured (RAZEKIT_GPU_INSTANCE_ID on the gateway)" : null),
      gpuCost: gpu ? gpuCostSoFar(gpu, config, now) : null,
      idleStopMinutes: Math.round(config.gpuIdleStopMs / 60_000),
      awsBudget: auditor.runtimeHealth?.spend?.awsBudget || null,
      awsBudgetSource: auditor.lastSuccessfulAudit ? "System B audit at " + auditor.lastSuccessfulAudit.at : null
    },
    approvals: db.opsApprovals.filter(item => item.status === "pending").slice(-20).reverse(),
    recentAdminActions: db.opsAdminAudit.slice(-10).reverse()
  };
}

function controlSummary(request) {
  return { request, note: "Recorded. It takes effect only when the target process accepts it; poll the request for its real state." };
}

/**
 * Handles /api/admin/ops/*. Returns true when it answered the request.
 */
export async function handleAdminOps({ req, res, p, principal, body, json, runtime }) {
  if (!p.startsWith("/api/admin/ops/")) return false;
  assertOperator(req.headers, principal);
  const actor = actorOf(principal);
  const method = req.method;
  const route = p.slice("/api/admin/ops".length);
  const audited = async (action, target, fn) => {
    try {
      const result = await fn();
      await adminAudit({ actor, actorRole: principal.role, action, target, outcome: "accepted", details: { result: result?.request?.status || result?.status || "ok" }, requestId: principal.requestId });
      return result;
    } catch (error) {
      await adminAudit({ actor, actorRole: principal.role, action, target, outcome: "rejected", details: { error: error.message }, requestId: principal.requestId }).catch(() => {});
      throw error;
    }
  };

  try {
    if (method === "GET" && route === "/dashboard") return json(res, 200, await buildDashboard({ runtime })), true;

    let m = route.match(/^\/systems\/(builder|auditor)$/);
    if (method === "GET" && m) {
      const db = await loadDb();
      const system = m[1];
      return json(res, 200, {
        system: SYSTEMS[system],
        tasks: db.opsTasks.filter(task => task.system === system).slice(-100).reverse().map(taskSummary),
        events: db.opsEvents.filter(event => event.source === system).slice(-100).reverse(),
        checkpoints: db.opsCheckpoints.filter(item => item.system === system).slice(-20).reverse().map(item => pick(item, ["id", "taskId", "seq", "step", "at"])),
        controls: db.opsControlRequests.filter(item => item.targetType === "system" && item.target === system).slice(-30).reverse()
      }), true;
    }

    m = route.match(/^\/systems\/(builder|auditor)\/control$/);
    if (method === "POST" && m) {
      const system = m[1];
      const input = await body(req);
      if (!SYSTEM_ACTIONS.includes(input.action)) throw new OpsHttpError(400, "Action must be one of " + SYSTEM_ACTIONS.join(", "));
      if (input.action === "stop_task" && !input.taskId) throw new OpsHttpError(400, "stop_task needs taskId");
      if (["pause", "stop_task"].includes(input.action) && input.confirm !== true) throw new OpsHttpError(409, "Confirmation required", { needsConfirmation: true });
      const request = await audited("system." + input.action, system, () => createControlRequest({
        targetType: "system", target: system, action: input.action, payload: input.taskId ? { taskId: input.taskId } : {}, requestedBy: actor
      }));
      return json(res, 202, controlSummary(request)), true;
    }

    m = route.match(/^\/systems\/(builder|auditor)\/tasks$/);
    if (method === "POST" && m) {
      const system = m[1];
      const input = await body(req);
      const kinds = system === "builder" ? BUILDER_KINDS : AUDITOR_KINDS;
      if (!kinds.includes(input.kind)) throw new OpsHttpError(400, "Task kind must be one of " + kinds.join(", "));
      if (system === "builder" && input.kind === "code.change" && !BUILDER_SCOPE_AREAS[input.scopeArea]) throw new OpsHttpError(400, "Choose one of the seven scope areas");
      const task = await audited("task.enqueue", system, () => enqueueTask({
        system, kind: input.kind, title: input.title || input.kind, goal: input.goal || "", scopeArea: input.scopeArea || null,
        origin: { type: "admin" }, requestedBy: actor, idempotencyKey: input.idempotencyKey || null
      }));
      return json(res, 201, { task: taskSummary(task), note: "Queued. It runs when the " + SYSTEMS[system].name + " process claims it." }), true;
    }

    m = route.match(/^\/tasks\/([^/]+)\/cancel$/);
    if (method === "POST" && m) {
      const input = await body(req);
      if (input.confirm !== true) throw new OpsHttpError(409, "Confirmation required", { needsConfirmation: true });
      const db = await loadDb();
      const task = db.opsTasks.find(item => item.id === m[1]);
      if (!task) throw new OpsHttpError(404, "Task not found");
      if ([TASK_STATUS.LEASED, TASK_STATUS.RUNNING].includes(task.status)) {
        throw new OpsHttpError(409, "This task is running; use Stop Current Task so its process stops it safely");
      }
      const result = await audited("task.cancel", task.id, () => cancelTask(task.id, { by: actor, reason: "Cancelled from the admin control center" }));
      return json(res, 200, { task: taskSummary(result) }), true;
    }

    m = route.match(/^\/control-requests\/([^/]+)$/);
    if (method === "GET" && m) {
      const request = await getControlRequest(m[1]);
      if (!request) throw new OpsHttpError(404, "Control request not found");
      return json(res, 200, { request }), true;
    }

    m = route.match(/^\/agents\/(niomi|konami)\/control$/);
    if (method === "POST" && m) {
      const input = await body(req);
      if (!AGENT_ACTIONS.includes(input.action)) throw new OpsHttpError(400, "Action must be pause or resume");
      if (input.action === "pause" && input.confirm !== true) throw new OpsHttpError(409, "Confirmation required", { needsConfirmation: true });
      const request = await audited("agent." + input.action, m[1], () => createControlRequest({ targetType: "agent", target: m[1], action: input.action, requestedBy: actor }));
      return json(res, 202, controlSummary(request)), true;
    }

    if (method === "GET" && route === "/models") {
      return json(res, 200, { config: await getModelConfig(), supported: supportedModels() }), true;
    }

    m = route.match(/^\/models\/(coding|reasoning)$/);
    if (method === "PUT" && m) {
      const input = await body(req);
      if (input.confirm !== input.model) throw new OpsHttpError(409, "Type the model ID again to confirm the change", { needsConfirmation: true });
      const result = await audited("model.assign", m[1], () => setModelAssignment(m[1], input.model, { by: actor, contextTokens: input.contextTokens ?? null }));
      return json(res, 200, result), true;
    }

    m = route.match(/^\/models\/(coding|reasoning)\/test$/);
    if (method === "POST" && m) {
      const request = await audited("model.test", m[1], () => enqueueModelTest(m[1], actor));
      return json(res, 202, { request: pick(request, ["id", "slot", "status", "createdAt"]), note: "Queued for the inference gateway. Passes only if the model itself calls the test tool." }), true;
    }

    m = route.match(/^\/models\/(coding|reasoning)\/acceptance-test$/);
    if (method === "POST" && m) {
      const kind = m[1] === "coding" ? "model.coding_test" : "model.reasoning_test";
      const task = await audited("model.acceptance_test", m[1], () => enqueueTask({
        system: "builder", kind, title: (m[1] === "coding" ? "Coding" : "Reasoning") + " model acceptance test", requestedBy: actor,
        origin: { type: "admin" }, idempotencyKey: "acceptance:" + m[1], timeoutMs: 60 * 60_000
      }));
      return json(res, 201, { task: taskSummary(task) }), true;
    }

    m = route.match(/^\/inference\/([^/]+)$/);
    if (method === "GET" && m) {
      const request = await getInference(m[1]);
      if (!request) throw new OpsHttpError(404, "Inference request not found");
      const { messages, tools, ...rest } = request;
      return json(res, 200, { request: rest }), true;
    }

    if (method === "POST" && route === "/compute/gpu") {
      const input = await body(req);
      if (!["start", "stop"].includes(input.action)) throw new OpsHttpError(400, "Action must be start or stop");
      const dashboard = await buildDashboard({ runtime });
      if (!dashboard.compute.gpuControlsAvailable) throw new OpsHttpError(409, dashboard.compute.gpuControlsReason);
      if (input.action === "stop") {
        const active = dashboard.models.queue.queued + dashboard.models.queue.dispatched + dashboard.systems.builder.queue.waitingInference;
        if (active > 0 && input.confirmActiveJobs !== true) {
          throw new OpsHttpError(409, active + " inference job(s) are queued or running. Confirm to stop the GPU anyway; they will wait until it starts again.", { needsConfirmation: true, activeJobs: active });
        }
      }
      if (input.confirm !== true) throw new OpsHttpError(409, "Confirmation required", { needsConfirmation: true });
      const action = "gpu_" + input.action;
      if (!GATEWAY_ACTIONS.includes(action)) throw new OpsHttpError(400, "Unsupported");
      const request = await audited("gpu." + input.action, "gateway", () => createControlRequest({ targetType: "gateway", target: "gateway", action, requestedBy: actor }));
      return json(res, 202, controlSummary(request)), true;
    }

    if (method === "GET" && route === "/logs") {
      const u = new URL(req.url, "http://x");
      const source = u.searchParams.get("source");
      if (source && !OPS_SOURCES.includes(source)) throw new OpsHttpError(400, "Unknown source");
      const events = await listEvents({ source, severity: u.searchParams.get("severity") || null, taskId: u.searchParams.get("taskId") || null, limit: Number(u.searchParams.get("limit") || 200) });
      return json(res, 200, { events }), true;
    }

    if (method === "GET" && route === "/audit") return json(res, 200, { entries: await listAdminAudit({ limit: 200 }) }), true;

    if (method === "GET" && route === "/approvals") return json(res, 200, { approvals: await listApprovals({ limit: 100 }) }), true;

    m = route.match(/^\/approvals\/([^/]+)\/decision$/);
    if (method === "POST" && m) {
      const input = await body(req);
      const approval = await getApproval(m[1]);
      if (!approval) throw new OpsHttpError(404, "Approval not found");
      const decided = await audited("approval." + input.decision, approval.id, () => decideApproval(approval.id, { decision: input.decision, by: actor, note: input.note }));
      let request = null;
      const ctl = approval.details?.controlRequest;
      if (decided.status === "approved" && ctl && ["system", "gateway", "agent"].includes(ctl.targetType)) {
        request = await createControlRequest({ ...ctl, requestedBy: actor + " (approval " + approval.id + ")" });
      }
      return json(res, 200, { approval: decided, controlRequest: request }), true;
    }

    if (method === "POST" && route === "/emergency-stop") {
      const input = await body(req);
      if (typeof input.engaged !== "boolean") throw new OpsHttpError(400, "engaged must be true or false");
      if (input.engaged && input.confirm !== "STOP") throw new OpsHttpError(409, "Type STOP to engage the emergency stop", { needsConfirmation: true });
      const value = input.engaged
        ? { engaged: true, by: actor, at: new Date().toISOString(), reason: String(input.reason || "Emergency stop").slice(0, 300) }
        : { engaged: false, by: actor, at: new Date().toISOString(), releasedAfter: input.reason || null };
      const row = await audited(input.engaged ? "emergency.engage" : "emergency.release", "all", () => setSetting("emergency-stop", value, actor));
      return json(res, 200, { emergency: row.value, note: input.engaged ? "Persisted. Every supervisor, the gateway and the agent coordinator read this flag on their next loop and stop autonomous work." : "Released. Paused systems stay paused until resumed." }), true;
    }

    throw new OpsHttpError(404, "Not found");
  } catch (error) {
    if (error instanceof OpsHttpError) return json(res, error.status, { error: error.message, ...error.extra }), true;
    if (error instanceof AuthError) throw error;
    const status = Number.isInteger(error?.status) ? error.status : 400;
    return json(res, status, { error: error.message }), true;
  }
}

export { MODEL_SLOTS, createApproval };
