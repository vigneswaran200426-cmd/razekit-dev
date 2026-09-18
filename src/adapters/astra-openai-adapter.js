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

// ASTRA — the planning, reasoning and review model. Backed by OpenAI's
// Responses API.
//
// Verified against OpenAI's current API documentation:
//   endpoint  POST /v1/responses
//   model     gpt-6-astra (flagship reasoning model)
//   params    instructions + input, with reasoning.effort of low|medium|high
//   output    an `output` array of message blocks; the `output_text` shortcut is
//             an SDK convenience, so the raw blocks are aggregated here and
//             output_text is only used if the wire actually carries it.

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-6-astra";

export class AstraOpenAIAdapter {
  constructor({
    apiKey = process.env.ASTRA_API_KEY,
    model = process.env.ASTRA_MODEL || DEFAULT_MODEL,
    endpoint = process.env.ASTRA_API_URL || DEFAULT_ENDPOINT,
    effort = process.env.ASTRA_EFFORT || "high",
    maxOutputTokens = readNumberEnv("ASTRA_MAX_OUTPUT_TOKENS", 16000),
    timeoutMs = readNumberEnv("ASTRA_TIMEOUT_MS", 600_000),
    inputCostPerMTok = readNumberEnv("ASTRA_INPUT_COST_PER_MTOK", 10),
    outputCostPerMTok = readNumberEnv("ASTRA_OUTPUT_COST_PER_MTOK", 50),
    organization = process.env.ASTRA_ORGANIZATION || null
  } = {}) {
    if (!apiKey?.trim()) {
      throw new Error("ASTRA_API_KEY is required to use the real Astra adapter");
    }
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
    this.effort = effort;
    this.maxOutputTokens = maxOutputTokens;
    this.timeoutMs = timeoutMs;
    this.inputCostPerMTok = inputCostPerMTok;
    this.outputCostPerMTok = outputCostPerMTok;
    this.organization = organization;
  }

  buildPrompt(request) {
    const context = request.context || {};
    if (request.role === MODEL_ROLES.IMPLEMENTER) return implementerPrompt(context);
    if (request.role === MODEL_ROLES.REVIEWER) return reviewerPrompt(context);
    return plannerPrompt(context);
  }

  async generate(request) {
    const headers = { authorization: "Bearer " + this.apiKey };
    if (this.organization) headers["openai-organization"] = this.organization;

    const response = await postJson(this.endpoint, {
      headers,
      timeoutMs: this.timeoutMs,
      body: {
        model: request.model && request.model !== "gpt-astra" ? request.model : this.model,
        instructions: SYSTEM_PROMPT,
        input: this.buildPrompt(request),
        reasoning: { effort: this.effort },
        max_output_tokens: this.maxOutputTokens
      }
    }).catch(error => {
      throw new ModelRuntimeError("Astra request failed: " + (error.message || "network error"), {
        retryable: true,
        code: "ASTRA_TRANSPORT_ERROR"
      });
    });

    if (!response.ok) {
      const detail = await safeErrorCode(response);
      throw new ModelRuntimeError(
        "Astra request rejected with HTTP " + response.status + (detail ? " (" + detail + ")" : ""),
        { retryable: isRetryableStatus(response.status), code: "ASTRA_HTTP_" + response.status }
      );
    }

    const payload = await response.json();

    // An incomplete response is a truncated one; parsing it would produce a
    // half-plan that reads as a real plan.
    if (payload.status === "incomplete") {
      throw new ModelRuntimeError(
        "Astra response incomplete (" + (payload.incomplete_details?.reason || "unspecified") + ")",
        { retryable: false, code: "ASTRA_INCOMPLETE" }
      );
    }

    const text = collectOutputText(payload);

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

async function safeErrorCode(response) {
  try {
    const body = await response.json();
    return body?.error?.code || body?.error?.type || null;
  } catch {
    return null;
  }
}

function collectOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  // Reasoning blocks also appear in `output`; only message text is wanted.
  return (payload.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(block => block.type === "output_text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

function shapeResponse(role, text) {
  const parsed = extractJsonObject(text, { what: "Astra " + role + " response" });

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
