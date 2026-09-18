import { MODEL_PROVIDERS } from "./model-runtime.js";
import { DeterministicFableAdapter, DeterministicAstraAdapter } from "./testing-model-adapters.js";
import { FableAnthropicAdapter } from "./adapters/fable-anthropic-adapter.js";
import { AstraOpenAIAdapter } from "./adapters/astra-openai-adapter.js";

// Chooses which Fable and Astra implementations the orchestrator gets.
//
// The deterministic adapters are not scaffolding to be replaced — they are how
// CI exercises the whole loop without a network or a bill, and they stay. This
// module is the one place that decides which pair is live, so nothing else in
// the system has to know whether it is talking to a real provider.

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

function realCredentialsPresent() {
  return Boolean(process.env.FABLE_API_KEY?.trim() && process.env.ASTRA_API_KEY?.trim());
}

/**
 * Registers the Fable and Astra adapters on a registry.
 *
 * Returns what was registered so the caller can log it. The return value names
 * providers and models only — never a key, and never anything derived from one.
 */
export function configureModelRegistry(registry) {
  const mode = requestedMode();

  // `real` is explicit: if it is asked for and the keys are absent, that is a
  // misconfigured deployment, not a reason to quietly fall back to adapters
  // that return canned text and would make a fake task look like a real one.
  if (mode === MODEL_MODE.REAL && !realCredentialsPresent()) {
    throw new Error(
      "RAZEKIT_MODEL_MODE=real requires both FABLE_API_KEY and ASTRA_API_KEY"
    );
  }

  const useReal = mode === MODEL_MODE.REAL || (mode === MODEL_MODE.AUTO && realCredentialsPresent());

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
    // Nothing registered. The registry raises MODEL_PROVIDER_NOT_CONFIGURED on
    // first use, which is the honest failure: no model is configured.
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
