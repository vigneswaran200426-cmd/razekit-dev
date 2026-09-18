export class ConfiguredGamePlaytestAdapter {
  constructor({ engineAdapters = new Map(), checks = {} } = {}) {
    this.engineAdapters = engineAdapters;
    this.checks = { ...checks };
  }

  async execute(step) {
    const engine = step.engine;
    const adapter = this.engineAdapters.get(engine);
    if (!adapter) throw new Error("No engine adapter is configured for playtest: " + engine);

    const checks = Array.isArray(step.checks) ? step.checks : [];
    const results = [];

    for (const check of checks) {
      const handler = this.checks[check];
      if (typeof handler === "function") {
        results.push({
          check,
          passed: Boolean(await handler({ step, adapter }))
        });
      } else {
        results.push({ check, passed: false, error: "No handler configured" });
      }
    }

    const failed = results.filter(result => !result.passed);
    if (failed.length > 0) {
      throw new Error("Game playtest failed: " + failed.map(result => result.check).join(", "));
    }

    return {
      ok: true,
      engine,
      passed: results.length,
      checks: results
    };
  }
}
