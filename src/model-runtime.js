export const MODEL_ROLES = {
  PLANNER: "planner",
  IMPLEMENTER: "implementer",
  REVIEWER: "reviewer"
};

export const MODEL_PROVIDERS = {
  FABLE: "fable",
  ASTRA: "astra"
};

export class ModelRuntimeError extends Error {
  constructor(message, { retryable = true, code = "MODEL_RUNTIME_ERROR" } = {}) {
    super(message);
    this.name = "ModelRuntimeError";
    this.retryable = retryable;
    this.code = code;
  }
}

export class ModelAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(provider, adapter) {
    if (!provider) throw new Error("Model provider is required");
    if (!adapter || typeof adapter.generate !== "function") {
      throw new Error("Model adapter must implement generate()");
    }
    this.adapters.set(provider, adapter);
  }

  get(provider) {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new ModelRuntimeError(
        "No model adapter configured for provider: " + provider,
        { retryable: false, code: "MODEL_PROVIDER_NOT_CONFIGURED" }
      );
    }
    return adapter;
  }

  has(provider) {
    return this.adapters.has(provider);
  }
}

export async function callModel(registry, request) {
  const adapter = registry.get(request.provider);
  const startedAt = Date.now();

  try {
    const result = await adapter.generate(request);
    return {
      ...result,
      provider: request.provider,
      role: request.role,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error instanceof ModelRuntimeError) throw error;
    const wrapped = new ModelRuntimeError(error.message || "Model call failed", {
      retryable: error.retryable !== false
    });
    // Only the adapter knows whether the request left this machine, and that
    // single bit decides whether a retry is free or pays a second time. Losing
    // it in the wrap would leave the classification guessing from the message.
    if (error.transmitted !== undefined) wrapped.transmitted = error.transmitted;
    if (error.providerRef !== undefined) wrapped.providerRef = error.providerRef;
    throw wrapped;
  }
}
