import { ModelRuntimeError, MODEL_ROLES } from "../model-runtime.js";
import {
  computeCost,
  extractJsonObject,
  isRetryableStatus,
  postJson,
  readNumberEnv
} from "./model-json.js";
import {
  SYSTEM_PROMPT,
  implementerPrompt,
  plannerPrompt,
  reviewerPrompt
} from "./model-prompts.js";

// FABLE — the implementation model. Backed by Anthropic's Messages API.
//
// Verified against Anthropic's current API documentation:
//   endpoint  POST /v1/messages, anthropic-version: 2023-06-01
//   model     claude-fable-5-1
//   thinking  always on for this model; sending `thinking`, `budget_tokens`,
//             `temperature` or a forced `tool_choice` is a 400, so none appear
//             below. Depth is controlled with output_config.effort instead.
//   refusal   returns HTTP 200 with stop_reason "refusal" — checked explicitly,
//             because reading .content first would yield an empty answer and a
//             confusing downstream parse error.

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-fable-5-1";
const ANTHROPIC_VERSION = "2023-06-01";

export class FableAnthropicAdapter {
  constructor({
    apiKey = process.env.FABLE_API_KEY,
    model = process.env.FABLE_MODEL || DEFAULT_MODEL,
    endpoint = process.env.FABLE_API_URL || DEFAULT_ENDPOINT,
    effort = process.env.FABLE_EFFORT || "high",
    maxTokens = readNumberEnv("FABLE_MAX_TOKENS", 16000),
    timeoutMs = readNumberEnv("FABLE_TIMEOUT_MS", 600_000),
    inputCostPerMTok = readNumberEnv("FABLE_INPUT_COST_PER_MTOK", 10),
    outputCostPerMTok = readNumberEnv("FABLE_OUTPUT_COST_PER_MTOK", 50)
  } = {}) {
    if (!apiKey?.trim()) {
      throw new Error("FABLE_API_KEY is required to use the real Fable adapter");
    }
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
    this.effort = effort;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.inputCostPerMTok = inputCostPerMTok;
    this.outputCostPerMTok = outputCostPerMTok;
  }

  buildPrompt(request) {
    const context = request.context || {};
    if (request.role === MODEL_ROLES.PLANNER) return plannerPrompt(context);
    if (request.role === MODEL_ROLES.REVIEWER) return reviewerPrompt(context);
    return implementerPrompt(context);
  }

  async generate(request) {
    const response = await postJson(this.endpoint, {
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      timeoutMs: this.timeoutMs,
      body: {
        model: request.model && request.model !== "fable-5.1" ? request.model : this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        output_config: { effort: this.effort },
        messages: [{ role: "user", content: this.buildPrompt(request) }]
      }
    }).catch(error => {
      // An aborted fetch is a timeout, and a timeout is worth another attempt.
      throw new ModelRuntimeError("Fable request failed: " + (error.message || "network error"), {
        retryable: true,
        code: "FABLE_TRANSPORT_ERROR"
      });
    });

    if (!response.ok) {
      // The body can echo request content; only the status and the provider's
      // own error type are surfaced, so nothing sensitive reaches a log.
      const detail = await safeErrorType(response);
      throw new ModelRuntimeError(
        "Fable request rejected with HTTP " + response.status + (detail ? " (" + detail + ")" : ""),
        { retryable: isRetryableStatus(response.status), code: "FABLE_HTTP_" + response.status }
      );
    }

    const payload = await response.json();

    if (payload.stop_reason === "refusal") {
      throw new ModelRuntimeError(
        "Fable declined this request (" + (payload.stop_details?.category || "unspecified") + ")",
        { retryable: false, code: "FABLE_REFUSAL" }
      );
    }

    const text = (payload.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim();

    if (payload.stop_reason === "max_tokens") {
      throw new ModelRuntimeError(
        "Fable response hit max_tokens and is truncated; raise FABLE_MAX_TOKENS",
        { retryable: false, code: "FABLE_TRUNCATED" }
      );
    }

    const usage = {
      inputTokens: Number(payload.usage?.input_tokens || 0),
      outputTokens: Number(payload.usage?.output_tokens || 0)
    };
    usage.cost = computeCost({
      ...usage,
      inputCostPerMTok: this.inputCostPerMTok,
      outputCostPerMTok: this.outputCostPerMTok
    });

    return { ...shapeResponse(request.role, text), usage };
  }
}

async function safeErrorType(response) {
  try {
    const body = await response.json();
    return body?.error?.type || null;
  } catch {
    return null;
  }
}

// Maps the JSON contract in model-prompts.js onto the fields the orchestrator
// writes to the blackboard. A role that returns the wrong shape fails here
// rather than silently producing an agent that never progresses.
function shapeResponse(role, text) {
  const parsed = extractJsonObject(text, { what: "Fable " + role + " response" });

  if (role === MODEL_ROLES.PLANNER) {
    return { output: parsed.summary || text, architecture: parsed };
  }

  if (role === MODEL_ROLES.REVIEWER) {
    return { output: parsed.reason || text, review: parsed };
  }

  return {
    output: parsed.summary || text,
    implementation: {
      status: "implemented",
      summary: parsed.summary || null,
      filesChanged: Number(parsed.filesChanged || 0)
    },
    plan: parsed.plan || null
  };
}
