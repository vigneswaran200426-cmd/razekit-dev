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

const DEFAULT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";

/**
 * Groq's OpenAI-compatible Chat Completions adapter.
 *
 * The free developer plan is rate-limited and availability can change. Keep
 * the model name configurable and do not silently switch to a paid provider.
 * This adapter sends only the task context compiled by RazeKit's model prompt.
 */
export class GroqOpenAIAdapter {
  constructor({
    apiKey = process.env.GROQ_API_KEY,
    model = process.env.GROQ_MODEL || DEFAULT_MODEL,
    endpoint = process.env.GROQ_API_URL || DEFAULT_ENDPOINT,
    maxTokens = readNumberEnv("GROQ_MAX_TOKENS", 8192),
    timeoutMs = readNumberEnv("GROQ_TIMEOUT_MS", 180_000),
    inputCostPerMTok = readNumberEnv("GROQ_INPUT_COST_PER_MTOK", 0),
    outputCostPerMTok = readNumberEnv("GROQ_OUTPUT_COST_PER_MTOK", 0)
  } = {}) {
    if (!apiKey?.trim()) {
      throw new Error("GROQ_API_KEY is required to use the Groq adapter");
    }
    if (!model?.trim()) throw new Error("GROQ_MODEL must not be empty");
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
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
    // Existing sessions may carry legacy aliases. The configured Groq model is
    // authoritative so a session cannot accidentally request another vendor.
    const response = await postJson(this.endpoint, {
      headers: { authorization: "Bearer " + this.apiKey },
      timeoutMs: this.timeoutMs,
      body: {
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: this.buildPrompt(request) }
        ],
        max_tokens: this.maxTokens,
        temperature: 0.1
      }
    }).catch(error => {
      throw new ModelRuntimeError("Groq request failed: " + (error.message || "network error"), {
        retryable: true,
        code: "GROQ_TRANSPORT_ERROR"
      });
    });

    if (!response.ok) {
      const detail = await safeErrorCode(response);
      throw new ModelRuntimeError(
        "Groq request rejected with HTTP " + response.status + (detail ? " (" + detail + ")" : ""),
        { retryable: isRetryableStatus(response.status), code: "GROQ_HTTP_" + response.status }
      );
    }

    const payload = await response.json();
    const choice = payload.choices?.[0];
    if (!choice) {
      throw new ModelRuntimeError("Groq response contained no choices", {
        retryable: false,
        code: "GROQ_EMPTY_RESPONSE"
      });
    }
    if (choice.finish_reason === "length") {
      throw new ModelRuntimeError("Groq response was truncated at max_tokens", {
        retryable: false,
        code: "GROQ_TRUNCATED"
      });
    }

    const content = choice.message?.content;
    const text = typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content.filter(part => part?.type === "text").map(part => part.text || "").join("\n").trim()
        : "";

    if (!text) {
      throw new ModelRuntimeError("Groq returned empty text content", {
        retryable: false,
        code: "GROQ_EMPTY_CONTENT"
      });
    }

    const usage = {
      inputTokens: Number(payload.usage?.prompt_tokens || 0),
      outputTokens: Number(payload.usage?.completion_tokens || 0)
    };
    usage.cost = computeCost({
      ...usage,
      inputCostPerMTok: this.inputCostPerMTok,
      outputCostPerMTok: this.outputCostPerMTok
    });

    return { ...shapeResponse(request.role, text), usage };
  }
}

async function safeErrorCode(response) {
  try {
    const body = await response.json();
    return body?.error?.code || body?.error?.type || null;
  } catch {
    return null;
  }
}

export function shapeResponse(role, text) {
  const parsed = extractJsonObject(text, { what: role + " model response" });

  if (role === MODEL_ROLES.IMPLEMENTER) {
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

  if (role === MODEL_ROLES.REVIEWER) {
    return { output: parsed.reason || text, review: parsed };
  }

  return { output: parsed.summary || text, architecture: parsed };
}
