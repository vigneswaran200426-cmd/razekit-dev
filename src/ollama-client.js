// A small client for the Ollama HTTP API. Only the gateway uses it; agents and
// supervisors go through the gateway's queue, never to the model server.
//
// The model server is private: it listens on the GPU instance's private
// address and its security group admits only the control plane. This client
// therefore refuses anything that is not plain HTTP(S) to a configured base.

export class OllamaError extends Error {
  constructor(message, { status = null, retryable = true } = {}) {
    super(message);
    this.name = "OllamaError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class OllamaClient {
  constructor({ baseUrl = process.env.RAZEKIT_OLLAMA_URL, timeoutMs = Number(process.env.RAZEKIT_OLLAMA_TIMEOUT_MS || 600_000), fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new OllamaError("RAZEKIT_OLLAMA_URL is not configured", { retryable: false });
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new OllamaError("Ollama URL must be HTTP(S)", { retryable: false });
    this.baseUrl = url.origin;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body = null, timeoutMs = 15_000, signal = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetch(this.baseUrl + path, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
      if (!response.ok) {
        throw new OllamaError("Ollama " + path + " HTTP " + response.status + ": " + (data.error || data.raw || "error"), {
          status: response.status,
          retryable: response.status >= 500 || response.status === 429
        });
      }
      return data;
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      throw new OllamaError("Ollama unreachable at " + this.baseUrl + ": " + (error.message || error), { retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  version() { return this.request("/api/version", { timeoutMs: 5000 }); }

  async installed() {
    const data = await this.request("/api/tags", { timeoutMs: 10_000 });
    return (data.models || []).map(model => ({
      name: model.name,
      sizeBytes: model.size,
      digest: model.digest,
      modifiedAt: model.modified_at,
      parameterSize: model.details?.parameter_size || null,
      quantization: model.details?.quantization_level || null,
      family: model.details?.family || null
    }));
  }

  async loaded() {
    const data = await this.request("/api/ps", { timeoutMs: 10_000 });
    return (data.models || []).map(model => ({
      name: model.name,
      sizeBytes: model.size,
      vramBytes: model.size_vram,
      expiresAt: model.expires_at,
      contextLength: model.context_length || null
    }));
  }

  /** Evicts a model from GPU memory without deleting it from disk. */
  unload(model) {
    return this.request("/api/generate", { method: "POST", body: { model, keep_alive: 0 }, timeoutMs: 60_000 });
  }

  async chat({ model, messages, tools = null, format = null, contextTokens = 16384, maxTokens = 2048, keepAlive = "10m", signal = null }) {
    const body = {
      model,
      messages,
      stream: false,
      keep_alive: keepAlive,
      options: { num_ctx: contextTokens, num_predict: maxTokens }
    };
    if (tools?.length) body.tools = tools;
    if (format) body.format = format;
    const data = await this.request("/api/chat", { method: "POST", body, timeoutMs: this.timeoutMs, signal });
    if (!data.message) throw new OllamaError("Ollama returned no message", { retryable: true });
    return {
      content: data.message.content || "",
      toolCalls: (data.message.tool_calls || []).map(call => ({
        name: call.function?.name,
        arguments: call.function?.arguments ?? {}
      })),
      doneReason: data.done_reason || null,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalDurationMs: Math.round((data.total_duration || 0) / 1e6),
        loadDurationMs: Math.round((data.load_duration || 0) / 1e6),
        evalDurationMs: Math.round((data.eval_duration || 0) / 1e6)
      }
    };
  }
}
