import { MODEL_PROVIDERS } from "./model-runtime.js";
import { DeterministicFableAdapter, DeterministicAstraAdapter } from "./testing-model-adapters.js";
import { FableAnthropicAdapter } from "./adapters/fable-anthropic-adapter.js";
import { AstraOpenAIAdapter } from "./adapters/astra-openai-adapter.js";
import { GroqOpenAIAdapter } from "./adapters/groq-openai-adapter.js";
import { OllamaGatewayAdapter } from "./adapters/ollama-gateway-adapter.js";

export const MODEL_MODE = {
  TEST: "test",
  REAL: "real",
  AUTO: "auto"
};

function requestedMode() {
  const mode = String(process.env.RAZEKIT_MODEL_MODE || MODEL_MODE.AUTO).toLowerCase();
  if (!Object.values(MODEL_MODE).includes(mode)) {
    throw new Error(
      "RAZEKIT_MODEL_MODE must be one of: " + Object.values(MODEL_MODE).join(", ")
    );
  }
  return mode;
}

function groqCredentialsPresent() {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

function legacyCredentialsPresent() {
  return Boolean(process.env.FABLE_API_KEY?.trim() && process.env.ASTRA_API_KEY?.trim());
}

function realCredentialsPresent() {
  return groqCredentialsPresent() || legacyCredentialsPresent();
}

/**
 * Registers a real provider pair or the deterministic test adapters.
 * Groq uses one key for both roles, so it can run without Claude or OpenAI
 * credentials. It is preferred when configured; no silent paid-provider
 * fallback is performed.
 */
export function configureModelRegistry(registry) {
  const mode = requestedMode();

  if (mode === MODEL_MODE.REAL && !realCredentialsPresent()) {
    throw new Error(
      "RAZEKIT_MODEL_MODE=real requires GROQ_API_KEY or both FABLE_API_KEY and ASTRA_API_KEY"
    );
  }

  // Local models through the shared gateway, chosen explicitly. Nothing falls
  // back to it, and it falls back to nothing: a queued request waits.
  if (mode !== MODEL_MODE.TEST && String(process.env.RAZEKIT_AGENT_MODEL_PROVIDER || "").toLowerCase() === "gateway") {
    const coder = new OllamaGatewayAdapter({ slot: "coding" });
    const planner = new OllamaGatewayAdapter({ slot: "reasoning" });
    registry.register(MODEL_PROVIDERS.FABLE, coder);
    registry.register(MODEL_PROVIDERS.ASTRA, planner);
    return {
      mode: MODEL_MODE.REAL,
      fable: { provider: "local-gateway", model: "coding slot" },
      astra: { provider: "local-gateway", model: "reasoning slot" }
    };
  }

  const useReal = mode === MODEL_MODE.REAL || (mode === MODEL_MODE.AUTO && realCredentialsPresent());

  if (useReal && groqCredentialsPresent()) {
    const coder = new GroqOpenAIAdapter({
      model: process.env.GROQ_CODER_MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-120b"
    });
    const planner = new GroqOpenAIAdapter({
      model: process.env.GROQ_PLANNER_MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-120b"
    });
    registry.register(MODEL_PROVIDERS.FABLE, coder);
    registry.register(MODEL_PROVIDERS.ASTRA, planner);
    return {
      mode: MODEL_MODE.REAL,
      fable: { provider: "groq", model: coder.model },
      astra: { provider: "groq", model: planner.model }
    };
  }

  if (useReal) {
    const fable = new FableAnthropicAdapter();
    const astra = new AstraOpenAIAdapter();
    registry.register(MODEL_PROVIDERS.FABLE, fable);
    registry.register(MODEL_PROVIDERS.ASTRA, astra);
    return {
      mode: MODEL_MODE.REAL,
      fable: { provider: "anthropic", model: fable.model },
      astra: { provider: "openai", model: astra.model }
    };
  }

  const testAdaptersEnabled =
    mode === MODEL_MODE.TEST || process.env.RAZEKIT_ENABLE_TEST_MODEL_ADAPTERS === "true";

  if (!testAdaptersEnabled) {
    return { mode: null, fable: null, astra: null };
  }

  registry.register(MODEL_PROVIDERS.FABLE, new DeterministicFableAdapter());
  registry.register(MODEL_PROVIDERS.ASTRA, new DeterministicAstraAdapter());
  return {
    mode: MODEL_MODE.TEST,
    fable: { provider: "deterministic", model: "fable-test" },
    astra: { provider: "deterministic", model: "astra-test" }
  };
}
