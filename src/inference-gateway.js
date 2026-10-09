import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { OllamaClient } from "./ollama-client.js";
import { GpuController } from "./gpu-controller.js";
import {
  acceptControlRequests,
  claimInference,
  emergencyState,
  enqueueInference,
  finishInference,
  getGpuState,
  getInference,
  getModelConfig,
  logEvent,
  recordModelTest,
  requeueStuckInference,
  resolveControlRequest,
  tokensUsedToday,
  updateGpuState,
  writeHeartbeat,
  writeModelStatus
} from "./ops-state.js";
import { loadDb } from "./store.js";
import { heartbeatThresholds } from "./ops-domain.js";

// The shared, budget-controlled inference gateway.
//
// Every model call from System A, System B, Niomi, Konami and the admin's test
// button is a row in one durable queue. This process drains it one request at
// a time, because a 24 GB GPU cannot hold both approved models at once
// (qwen3-coder:30b and gpt-oss:20b together exceed it): before a request runs,
// any other model is evicted, so exactly one is ever loaded.
//
// When inference is unavailable — the GPU is stopped, Ollama is down, the
// budget is spent, or the emergency stop is engaged — requests simply wait.
// Nothing here ever produces a result that a model did not produce.

export const MODEL_TEST_TOOL = {
  type: "function",
  function: {
    name: "report_status",
    description: "Report that the model is working, with the model's own name.",
    parameters: {
      type: "object",
      properties: { ok: { type: "boolean" }, note: { type: "string" } },
      required: ["ok"]
    }
  }
};

export function gatewayConfig(env = process.env) {
  return {
    ollamaUrl: env.RAZEKIT_OLLAMA_URL || null,
    gpuInstanceId: env.RAZEKIT_GPU_INSTANCE_ID || null,
    gpuHourlyUsd: env.RAZEKIT_GPU_HOURLY_USD ? Number(env.RAZEKIT_GPU_HOURLY_USD) : null,
    gpuMonthlyBudgetUsd: env.RAZEKIT_GPU_MONTHLY_BUDGET_USD ? Number(env.RAZEKIT_GPU_MONTHLY_BUDGET_USD) : null,
    gpuIdleStopMs: Math.max(60_000, Number(env.RAZEKIT_GPU_IDLE_STOP_MINUTES || 20) * 60_000),
    gpuAutoStart: String(env.RAZEKIT_GPU_AUTO_START || "false") === "true",
    dailyTokenBudget: {
      builder: Number(env.RAZEKIT_TOKENS_PER_DAY_BUILDER || 2_000_000),
      auditor: Number(env.RAZEKIT_TOKENS_PER_DAY_AUDITOR || 500_000),
      niomi: Number(env.RAZEKIT_TOKENS_PER_DAY_NIOMI || 2_000_000),
      konami: Number(env.RAZEKIT_TOKENS_PER_DAY_KONAMI || 2_000_000),
      admin: Number(env.RAZEKIT_TOKENS_PER_DAY_ADMIN || 200_000),
      gateway: 0
    }
  };
}

const monthKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

export function gpuCostSoFar(gpuState, config, now = Date.now()) {
  const ms = gpuState?.runningMsByMonth?.[monthKey(now)] || 0;
  const hours = ms / 3_600_000;
  return {
    month: monthKey(now),
    runningHours: Number(hours.toFixed(3)),
    estimatedUsd: config.gpuHourlyUsd == null ? null : Number((hours * config.gpuHourlyUsd).toFixed(2)),
    budgetUsd: config.gpuMonthlyBudgetUsd,
    remainingUsd: config.gpuHourlyUsd == null || config.gpuMonthlyBudgetUsd == null
      ? null
      : Number(Math.max(0, config.gpuMonthlyBudgetUsd - hours * config.gpuHourlyUsd).toFixed(2)),
    rateSource: config.gpuHourlyUsd == null ? "not configured" : "RAZEKIT_GPU_HOURLY_USD (configured on-demand rate, not a bill)"
  };
}

export class InferenceGateway {
  constructor({
    ollama = null,
    gpu = new GpuController(),
    env = process.env,
    processId = "gateway-" + os.hostname() + "-" + process.pid + "-" + randomUUID().slice(0, 8)
  } = {}) {
    this.env = env;
    this.config = gatewayConfig(env);
    this.processId = processId;
    this.gpu = gpu;
    this.ollama = ollama || (this.config.ollamaUrl ? new OllamaClient({ baseUrl: this.config.ollamaUrl }) : null);
    this.startedAt = new Date().toISOString();
    this.lastGpuCheckAt = 0;
    this.lastActivityAt = Date.now();
    this.ollamaStatus = { reachable: false, error: "not checked yet" };
    this.busy = false;
  }

  async heartbeat(status, extra = {}) {
    const queue = await this.queueDepth();
    return writeHeartbeat("gateway", {
      processId: this.processId,
      processStartedAt: this.startedAt,
      host: os.hostname(),
      pid: process.pid,
      status,
      ollamaUrlConfigured: Boolean(this.config.ollamaUrl),
      ollamaReachable: this.ollamaStatus.reachable,
      ollamaError: this.ollamaStatus.error || null,
      queueDepth: queue.queued,
      dispatched: queue.dispatched,
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      resources: { loadavg: os.loadavg(), freeMemBytes: os.freemem(), totalMemBytes: os.totalmem() },
      ...extra
    });
  }

  async queueDepth() {
    const db = await loadDb();
    return {
      queued: db.opsInferenceRequests.filter(item => item.status === "queued").length,
      dispatched: db.opsInferenceRequests.filter(item => item.status === "dispatched").length
    };
  }

  async refreshOllama() {
    if (!this.ollama) {
      this.ollamaStatus = { reachable: false, error: "RAZEKIT_OLLAMA_URL is not configured" };
      await writeModelStatus({ reachable: false, runtime: null, error: this.ollamaStatus.error, models: {} });
      return this.ollamaStatus;
    }
    try {
      const version = await this.ollama.version();
      const installed = await this.ollama.installed();
      const loaded = await this.ollama.loaded();
      const config = await getModelConfig();
      const models = {};
      for (const slot of Object.values(config.slots)) {
        const match = installed.find(item => item.name === slot.model);
        const running = loaded.find(item => item.name === slot.model);
        models[slot.model] = {
          installed: Boolean(match),
          sizeBytes: match?.sizeBytes ?? null,
          digest: match?.digest ?? null,
          quantization: match?.quantization ?? null,
          parameterSize: match?.parameterSize ?? null,
          loaded: Boolean(running),
          vramBytes: running?.vramBytes ?? null,
          checkedAt: new Date().toISOString()
        };
      }
      this.ollamaStatus = { reachable: true, error: null, version: version.version };
      await writeModelStatus({ reachable: true, runtime: { name: "ollama", version: version.version }, loaded, models });
    } catch (error) {
      this.ollamaStatus = { reachable: false, error: error.message };
      await writeModelStatus({ reachable: false, runtime: null, error: error.message, models: {} });
    }
    return this.ollamaStatus;
  }

  /**
   * Observes the GPU instance and accrues its running time from consecutive
   * observations. The figure is measured, at the resolution of the poll; the
   * cost derived from it uses the configured hourly rate and says so.
   */
  async observeGpu(now = Date.now()) {
    if (!this.gpu?.configured) {
      await updateGpuState({ configured: false, state: "not_configured", checkedAt: new Date(now).toISOString() });
      return null;
    }
    const prior = await getGpuState();
    let observed;
    try {
      observed = await this.gpu.describe();
    } catch (error) {
      await updateGpuState({ configured: true, lastError: error.message, checkedAt: new Date(now).toISOString() });
      return null;
    }
    const runningMsByMonth = { ...(prior?.runningMsByMonth || {}) };
    if (prior?.state === "running" && observed.state === "running" && prior.observedAt) {
      const delta = Math.max(0, Math.min(now - Date.parse(prior.observedAt), 10 * 60_000));
      runningMsByMonth[monthKey(now)] = (runningMsByMonth[monthKey(now)] || 0) + delta;
    }
    const state = await updateGpuState({
      configured: true,
      ...observed,
      observedAt: new Date(now).toISOString(),
      runningMsByMonth,
      lastError: null,
      lastActivityAt: new Date(this.lastActivityAt).toISOString()
    });
    return state;
  }

  async budgetAllowsGpu() {
    const state = await getGpuState();
    const cost = gpuCostSoFar(state, this.config);
    if (cost.remainingUsd == null) return { allowed: false, reason: "GPU hourly rate or monthly budget is not configured; refusing to run GPU compute without a hard limit", cost };
    if (cost.remainingUsd < (this.config.gpuHourlyUsd || 0)) return { allowed: false, reason: "Monthly GPU budget is exhausted (less than one hour remains)", cost };
    return { allowed: true, cost };
  }

  async startGpu(reason) {
    const budget = await this.budgetAllowsGpu();
    if (!budget.allowed) throw new Error(budget.reason);
    const result = await this.gpu.start();
    await logEvent({ source: "gateway", severity: "warn", action: "gpu.start", result: "requested", message: reason, data: result });
    this.lastActivityAt = Date.now();
    return result;
  }

  async stopGpu(reason) {
    const result = await this.gpu.stop();
    await logEvent({ source: "gateway", severity: "warn", action: "gpu.stop", result: "requested", message: reason, data: result });
    return result;
  }

  async handleControls() {
    const requests = await acceptControlRequests("gateway", "gateway", this.processId);
    for (const request of requests) {
      try {
        let evidence;
        if (request.action === "gpu_start") evidence = await this.startGpu("Admin request " + request.id + " by " + request.requestedBy);
        else if (request.action === "gpu_stop") evidence = await this.stopGpu("Admin request " + request.id + " by " + request.requestedBy);
        else throw new Error("Unsupported gateway action: " + request.action);
        const described = await this.gpu.describe().catch(() => null);
        await resolveControlRequest(request.id, { status: "completed", evidence: { ...evidence, observedState: described?.state || null } });
      } catch (error) {
        await resolveControlRequest(request.id, { status: "failed", error: error.message });
      }
    }
  }

  async dispatchOne() {
    const request = await claimInference(this.processId);
    if (!request) return null;
    const config = await getModelConfig();
    const slot = config.slots[request.slot];
    const budget = this.config.dailyTokenBudget[request.requester] ?? 0;
    const used = await tokensUsedToday(request.requester);
    if (budget > 0 && used >= budget) {
      return finishInference(request.id, { ok: false, model: slot.model, error: "Daily token budget for " + request.requester + " is spent (" + used + "/" + budget + ")" });
    }
    try {
      // One model on the GPU at a time.
      const loaded = await this.ollama.loaded();
      for (const model of loaded) {
        if (model.name !== slot.model) {
          await this.ollama.unload(model.name);
          await logEvent({ source: "gateway", action: "model.unloaded", message: model.name + " evicted to load " + slot.model });
        }
      }
      const started = Date.now();
      const response = await this.ollama.chat({
        model: slot.model,
        messages: request.messages,
        tools: request.tools,
        format: request.format,
        contextTokens: slot.contextTokens,
        maxTokens: request.maxTokens
      });
      this.lastActivityAt = Date.now();
      const finished = await finishInference(request.id, { ok: true, model: slot.model, result: response, usage: response.usage });
      if (request.purpose === "model-test") await this.recordTest(request, slot.model, response, Date.now() - started);
      return finished;
    } catch (error) {
      this.lastActivityAt = Date.now();
      const finished = await finishInference(request.id, { ok: false, model: slot.model, error: error.message });
      if (request.purpose === "model-test") await recordModelTest(slot.model, { ok: false, slot: request.slot, requestId: request.id, error: error.message });
      await logEvent({ source: "gateway", severity: "error", action: "inference.failed", message: error.message, data: { requestId: request.id, requester: request.requester } });
      return finished;
    }
  }

  async recordTest(request, model, response, latencyMs) {
    const toolCall = response.toolCalls.find(call => call.name === "report_status");
    const ok = Boolean(toolCall && (toolCall.arguments?.ok === true || toolCall.arguments?.ok === "true"));
    await recordModelTest(model, {
      ok,
      slot: request.slot,
      requestId: request.id,
      toolCalling: Boolean(toolCall),
      latencyMs,
      usage: response.usage,
      error: ok ? null : "The model did not call report_status with ok=true; content: " + String(response.content).slice(0, 300)
    });
  }

  async tick(now = Date.now()) {
    const emergency = await emergencyState();
    await this.handleControls();
    await this.refreshOllama();
    if (now - this.lastGpuCheckAt >= 60_000) {
      this.lastGpuCheckAt = now;
      await this.observeGpu(now);
    }
    await requeueStuckInference(20 * 60_000, now);

    const gpuState = await getGpuState();
    const budget = await this.budgetAllowsGpu();
    if (this.gpu?.configured && gpuState?.state === "running" && !budget.allowed && budget.cost.remainingUsd != null) {
      await this.stopGpu("Hard budget limit: " + budget.reason).catch(error => logEvent({ source: "gateway", severity: "critical", action: "gpu.stop_failed", message: error.message }));
    }

    const queue = await this.queueDepth();
    let status = emergency.engaged ? "paused" : "running";
    let reason = emergency.engaged ? "Emergency stop engaged: no inference is dispatched" : null;

    if (!emergency.engaged && queue.queued > 0) {
      if (this.ollamaStatus.reachable) {
        await this.dispatchOne();
      } else if (this.gpu?.configured && this.config.gpuAutoStart && gpuState?.state === "stopped") {
        if (budget.allowed) {
          await this.startGpu(queue.queued + " inference request(s) waiting").catch(error => logEvent({ source: "gateway", severity: "error", action: "gpu.start_failed", message: error.message }));
        } else {
          reason = "Requests are queued, GPU not started: " + budget.reason;
        }
      } else {
        reason = "Requests are queued; inference is unavailable (" + (this.ollamaStatus.error || "GPU stopped") + ")";
      }
    }

    if (this.gpu?.configured && gpuState?.state === "running" && queue.queued === 0 && queue.dispatched === 0 &&
        now - this.lastActivityAt > this.config.gpuIdleStopMs) {
      await this.stopGpu("Idle for " + Math.round((now - this.lastActivityAt) / 60_000) + " min").catch(error => logEvent({ source: "gateway", severity: "error", action: "gpu.idle_stop_failed", message: error.message }));
    }

    await this.heartbeat(status, { statusReason: reason, gpuState: gpuState?.state || "not_configured" });
    return { status, queue };
  }

  async run({ signal } = {}) {
    const { intervalMs } = heartbeatThresholds(this.env);
    await logEvent({ source: "gateway", action: "process.started", message: "Inference gateway " + this.processId + " started" });
    // Same watchdog as the supervisors: a hung loop exits and is restarted.
    let lastTickAt = Date.now();
    const watchdogMs = Number(this.env.RAZEKIT_OPS_WATCHDOG_MS || 15 * 60_000);
    const watchdog = setInterval(() => {
      if (Date.now() - lastTickAt > watchdogMs) {
        console.error("[gateway] watchdog: no loop iteration in " + Math.round(watchdogMs / 1000) + "s; exiting for a restart");
        process.exit(70);
      }
    }, 30_000);
    watchdog.unref();
    while (!signal?.aborted) {
      lastTickAt = Date.now();
      try {
        await this.tick();
      } catch (error) {
        await logEvent({ source: "gateway", severity: "error", action: "tick.failed", message: error.message }).catch(() => {});
        await this.heartbeat("failed", { statusReason: error.message }).catch(() => {});
      }
      await new Promise(resolve => setTimeout(resolve, this.ollamaStatus.reachable ? Math.min(intervalMs, 3000) : intervalMs));
    }
    clearInterval(watchdog);
    await this.heartbeat("stopped", { statusReason: "Shut down" }).catch(() => {});
  }
}

// ── Client side, used by the supervisors and agents ─────────────────────────

export function requestInference(options) {
  return enqueueInference(options);
}

/**
 * Waits for a queued request, up to a deadline. Returns the request in
 * whatever state it is actually in — a caller that gets "queued" back parks
 * its task; it never assumes an answer.
 */
export async function awaitInference(requestId, { timeoutMs = 60_000, pollMs = 2000, signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const request = await getInference(requestId);
    if (!request) throw new Error("Inference request vanished: " + requestId);
    if (["completed", "failed", "cancelled"].includes(request.status)) return request;
    if (Date.now() >= deadline || signal?.aborted) return request;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

export function enqueueModelTest(slot, requestedBy) {
  return enqueueInference({
    requester: "admin",
    slot,
    purpose: "model-test",
    messages: [
      { role: "system", content: "You are a health check. Respond only by calling the provided tool." },
      { role: "user", content: "Call report_status with ok=true and a one-sentence note naming yourself. Requested by " + requestedBy + "." }
    ],
    tools: [MODEL_TEST_TOOL],
    maxTokens: 256
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
  new InferenceGateway().run({ signal: controller.signal }).then(() => process.exit(0), error => {
    console.error("[gateway] fatal:", error.message);
    process.exit(1);
  });
}
