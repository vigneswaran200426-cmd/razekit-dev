import { ModelRuntimeError, MODEL_ROLES } from "../model-runtime.js";
import { SYSTEM_PROMPT, implementerPrompt, plannerPrompt, reviewerPrompt } from "./model-prompts.js";
import { shapeResponse } from "./groq-openai-adapter.js";
import { awaitInference, requestInference } from "../inference-gateway.js";

/**
 * Niomi's and Konami's model calls through the shared local-model gateway.
 *
 * Implementation goes to the coding slot (qwen3-coder:30b by default);
 * planning and review go to the reasoning slot (gpt-oss:20b). The request is a
 * row in the gateway's durable queue, attributed to the agent that made it, so
 * it is budgeted and accounted with System A's and System B's work.
 *
 * The queue is shared through the database, so this works from any host — the
 * DEV web service on Render enqueues, the gateway on AWS answers. When no
 * answer arrives in time (GPU stopped, budget spent) the call fails as
 * retryable and the agent loop tries again later. It never returns text a
 * model did not write.
 */
export class OllamaGatewayAdapter {
  constructor({ slot, waitMs = Number(process.env.RAZEKIT_GATEWAY_WAIT_MS || 300_000), pollMs = 2000 } = {}) {
    if (!["coding", "reasoning"].includes(slot)) throw new Error("slot must be coding or reasoning");
    this.slot = slot;
    this.waitMs = waitMs;
    this.pollMs = pollMs;
    this.model = "gateway:" + slot;
    this.pending = new Map();
  }

  buildPrompt(request) {
    const context = request.context || {};
    if (request.role === MODEL_ROLES.PLANNER) return plannerPrompt(context);
    if (request.role === MODEL_ROLES.REVIEWER) return reviewerPrompt(context);
    return implementerPrompt(context);
  }

  async generate(request) {
    const requester = request.context?.agent?.type === "konami" ? "konami" : "niomi";
    const key = (request.context?.agent?.id || "agent") + ":" + request.role + ":" + (request.requestId || request.context?.task?.id || "");
    let requestId = this.pending.get(key);
    if (!requestId) {
      const queued = await requestInference({
        requester,
        slot: this.slot,
        purpose: requester + ":" + request.role,
        taskId: request.context?.task?.id || null,
        format: "json",
        maxTokens: 8192,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: this.buildPrompt(request) }
        ]
      });
      requestId = queued.id;
      this.pending.set(key, requestId);
    }
    const result = await awaitInference(requestId, { timeoutMs: this.waitMs, pollMs: this.pollMs });
    if (result.status === "queued" || result.status === "dispatched") {
      throw new ModelRuntimeError("Local inference is not available yet (request " + requestId + " is " + result.status + ")", { retryable: true, code: "GATEWAY_QUEUED" });
    }
    this.pending.delete(key);
    if (result.status !== "completed") {
      throw new ModelRuntimeError("Local inference failed: " + (result.error || result.status), { retryable: true, code: "GATEWAY_FAILED" });
    }
    const text = String(result.result?.content || "").trim();
    if (!text) throw new ModelRuntimeError("The local model returned empty content", { retryable: false, code: "GATEWAY_EMPTY" });
    return {
      ...shapeResponse(request.role, text),
      usage: {
        inputTokens: Number(result.usage?.promptTokens || 0),
        outputTokens: Number(result.usage?.completionTokens || 0),
        cost: 0
      },
      model: result.model
    };
  }
}
