import test from "node:test";
import assert from "node:assert/strict";
import { ModelAdapterRegistry, MODEL_PROVIDERS, MODEL_ROLES, ModelRuntimeError } from "../src/model-runtime.js";
import { configureModelRegistry } from "../src/model-providers.js";
import { GroqOpenAIAdapter } from "../src/adapters/groq-openai-adapter.js";

function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("real mode can configure both model roles with only a Groq key", async () => {
  await withEnv({
    RAZEKIT_MODEL_MODE: "real",
    GROQ_API_KEY: "test-groq-key",
    GROQ_MODEL: "openai/gpt-oss-20b",
    GROQ_CODER_MODEL: undefined,
    GROQ_PLANNER_MODEL: undefined,
    FABLE_API_KEY: undefined,
    ASTRA_API_KEY: undefined,
    RAZEKIT_ENABLE_TEST_MODEL_ADAPTERS: undefined
  }, () => {
    const registry = new ModelAdapterRegistry();
    const result = configureModelRegistry(registry);
    assert.equal(result.mode, "real");
    assert.equal(result.fable.provider, "groq");
    assert.equal(result.astra.provider, "groq");
    assert.equal(result.fable.model, "openai/gpt-oss-20b");
    assert.equal(registry.has(MODEL_PROVIDERS.FABLE), true);
    assert.equal(registry.has(MODEL_PROVIDERS.ASTRA), true);
  });
});

test("Groq adapter sends planner prompts and maps JSON/usage to the orchestrator contract", async () => {
  const priorFetch = globalThis.fetch;
  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedBody = null;
  globalThis.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            summary: "Build a small verified module.",
            steps: [{ id: "create-module", kind: "implementation", description: "Create module and tests." }],
            files: [{ path: "src/module.js", purpose: "Module implementation." }],
            acceptanceCriteria: ["The module tests pass."],
            risks: []
          })
        }
      }],
      usage: { prompt_tokens: 25, completion_tokens: 35 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const adapter = new GroqOpenAIAdapter({
      apiKey: "secret-test-key",
      model: "openai/gpt-oss-20b",
      endpoint: "https://groq.test/chat/completions",
      timeoutMs: 1000,
      inputCostPerMTok: 0,
      outputCostPerMTok: 0
    });
    const result = await adapter.generate({
      role: MODEL_ROLES.PLANNER,
      context: {
        task: { type: "app", title: "Test task", request: "Create a module", specification: "Small module" },
        blackboard: [],
        recentMessages: []
      }
    });
    assert.equal(capturedUrl, "https://groq.test/chat/completions");
    assert.equal(capturedHeaders.authorization, "Bearer secret-test-key");
    assert.equal(capturedBody.model, "openai/gpt-oss-20b");
    assert.equal(capturedBody.messages[0].role, "system");
    assert.match(capturedBody.messages[1].content, /Test task/);
    assert.equal(result.architecture.summary, "Build a small verified module.");
    assert.equal(result.usage.inputTokens, 25);
    assert.equal(result.usage.outputTokens, 35);
    assert.equal(result.usage.cost, 0);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("Groq 429 response is marked retryable without exposing response bodies", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: "rate_limit_exceeded", message: "sensitive provider detail" }
  }), { status: 429, headers: { "content-type": "application/json" } });
  try {
    const adapter = new GroqOpenAIAdapter({
      apiKey: "secret-test-key",
      model: "openai/gpt-oss-20b",
      endpoint: "https://groq.test/chat/completions",
      timeoutMs: 1000
    });
    await assert.rejects(
      adapter.generate({ role: MODEL_ROLES.PLANNER, context: { task: {}, blackboard: [], recentMessages: [] } }),
      error => {
        assert.ok(error instanceof ModelRuntimeError);
        assert.equal(error.retryable, true);
        assert.equal(error.code, "GROQ_HTTP_429");
        assert.doesNotMatch(error.message, /secret-test-key|sensitive provider detail/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});
