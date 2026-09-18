export class DeterministicAppWebServiceAdapter {
  constructor({ calls = [] } = {}) {
    this.calls = calls;
  }

  async execute(step) {
    this.calls.push({ type: "service", operation: step.operation || null });
    return {
      ok: true,
      service: step.operation || "service",
      provider: step.provider || "test-provider"
    };
  }
}

export class DeterministicBrowserAdapter {
  constructor({ calls = [] } = {}) {
    this.calls = calls;
  }

  async execute(step) {
    this.calls.push({ type: "browser", url: step.url || null });
    return {
      ok: true,
      url: step.url || "http://test.local",
      checks: step.checks || []
    };
  }
}

export class DeterministicDeploymentAdapter {
  constructor({ calls = [] } = {}) {
    this.calls = calls;
  }

  async execute(step) {
    this.calls.push({ type: "deploy", target: step.target || null });
    return {
      ok: true,
      deploymentId: "test-deploy-" + this.calls.length,
      target: step.target || "test"
    };
  }
}

export class DeterministicExecutionRuntime {
  constructor() {
    this.calls = [];
    this.cancelled = false;
  }

  async execute(step) {
    this.calls.push(step.kind);
    return { ok: true, kind: step.kind };
  }

  cancel() {
    this.cancelled = true;
  }
}
