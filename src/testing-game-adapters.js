export class DeterministicGameEngineAdapter {
  constructor({ calls = [] } = {}) {
    this.calls = calls;
  }

  async execute(step) {
    this.calls.push({ type: "engine", action: step.action, engine: step.engine });
    return {
      ok: true,
      engine: step.engine,
      action: step.action
    };
  }

  async build(step) {
    this.calls.push({ type: "build", engine: step.engine, target: step.target || "development" });
    return {
      ok: true,
      engine: step.engine,
      target: step.target || "development",
      outputPath: "build/" + step.engine
    };
  }
}

export class DeterministicGamePlaytestAdapter {
  constructor({ calls = [] } = {}) {
    this.calls = calls;
  }

  async execute(step) {
    this.calls.push({ type: "playtest", engine: step.engine });
    return {
      ok: true,
      engine: step.engine,
      checks: step.checks || [],
      passed: (step.checks || []).length
    };
  }
}

export class DeterministicGamePackagerAdapter {
  constructor({ calls = [] } = {}) {
    this.calls = calls;
    this.packageCount = 0;
  }

  async package(step) {
    this.packageCount += 1;
    this.calls.push({ type: "package", engine: step.engine });
    return {
      ok: true,
      engine: step.engine,
      artifactId: "game-artifact-" + this.packageCount,
      path: step.outputDir || "artifacts"
    };
  }
}
