import { createGameArtifactManifest } from "./game-artifacts.js";

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

/**
 * A packager that actually packages.
 *
 * It previously returned a success descriptor and wrote nothing, which made it
 * a fake-success adapter: verification checks that the recorded artifact really
 * exists in the workspace, and it never did. A test double may be deterministic
 * and cheap, but it must not claim an artifact it did not produce — otherwise
 * every test built on it proves the opposite of what it appears to.
 *
 * It now delegates to the same manifest writer the real default packaging path
 * uses, so the evidence verification reads is genuine.
 */
export class DeterministicGamePackagerAdapter {
  constructor({ calls = [] } = {}) {
    this.calls = calls;
    this.packageCount = 0;
  }

  async package(step) {
    this.packageCount += 1;
    this.calls.push({ type: "package", engine: step.engine });

    const manifest = await createGameArtifactManifest(step.workspaceRoot, {
      engine: step.engine,
      artifactName: step.artifactName || "razekit-game",
      outputDir: step.outputDir || "artifacts"
    });

    return {
      ok: true,
      engine: step.engine,
      packageCount: this.packageCount,
      ...manifest
    };
  }
}
