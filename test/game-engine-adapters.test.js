import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-game-engine-contracts-"));
process.env.RAZEKIT_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "razekit-dev-game-engine-data-"));

const { GAME_ENGINES } = await import("../src/game-domain.js");
const { ConfiguredGameEngineAdapter, createConfiguredGameEngineAdapters } = await import("../src/game-engine-adapters.js");
const { ConfiguredGamePlaytestAdapter } = await import("../src/game-playtest-adapters.js");
const { createGameArtifactManifest } = await import("../src/game-artifacts.js");

test("configured adapters expose independent Unity, Unreal and Godot engine contracts", async () => {
  const calls = [];
  const runner = async input => {
    calls.push(input);
    return { ok: true, executable: input.executable, args: input.args };
  };

  const adapters = createConfiguredGameEngineAdapters({
    unity: {
      executable: "unity",
      actions: { open: ["-batchmode", "-quit"] },
      buildArgs: ["-batchmode", "-buildWindows64Player", "build/Game.exe"],
      processRunner: runner
    },
    unreal: {
      executable: "UnrealEditor",
      actions: { generate: ["-run=GenerateProjectFiles"] },
      buildArgs: ["-run=BuildCookRun"],
      processRunner: runner
    },
    godot: {
      executable: "godot",
      actions: { import: ["--editor", "--headless", "--quit"] },
      buildArgs: ["--headless", "--editor", "--quit"],
      processRunner: runner
    }
  });

  assert.equal(adapters.size, 3);

  const unity = adapters.get(GAME_ENGINES.UNITY).attachWorkspace(root);
  const unreal = adapters.get(GAME_ENGINES.UNREAL).attachWorkspace(root);
  const godot = adapters.get(GAME_ENGINES.GODOT).attachWorkspace(root);

  await unity.execute({ engine: GAME_ENGINES.UNITY, action: "open", args: ["Project"] });
  await unreal.execute({ engine: GAME_ENGINES.UNREAL, action: "generate" });
  await godot.build({
    engine: GAME_ENGINES.GODOT,
    outputDir: "build"
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(x => x.args), [
    ["-batchmode", "-quit", "Project"],
    ["-run=GenerateProjectFiles"],
    ["--headless", "--editor", "--quit"]
  ]);
  assert.ok(calls.every(x => x.cwd === root));
});

test("configured playtest adapters require explicit check handlers and fail closed", async () => {
  const engineAdapter = new ConfiguredGameEngineAdapter({
    engine: GAME_ENGINES.GODOT,
    executable: "godot",
    actions: {},
    buildArgs: [],
    processRunner: async () => ({ ok: true })
  }).attachWorkspace(root);

  const playtest = new ConfiguredGamePlaytestAdapter({
    engineAdapters: new Map([[GAME_ENGINES.GODOT, engineAdapter]]),
    checks: {
      "project opens": async () => true,
      "main scene loads": async () => true
    }
  });

  const result = await playtest.execute({
    engine: GAME_ENGINES.GODOT,
    checks: ["project opens", "main scene loads"]
  });
  assert.equal(result.passed, 2);

  const failing = new ConfiguredGamePlaytestAdapter({
    engineAdapters: new Map([[GAME_ENGINES.GODOT, engineAdapter]]),
    checks: {}
  });
  await assert.rejects(
    () => failing.execute({
      engine: GAME_ENGINES.GODOT,
      checks: ["project opens"]
    }),
    /Game playtest failed/
  );
});

test("game artifact manifest stays inside the workspace and inventories files", async () => {
  const gameRoot = await mkdtemp(path.join(root, "game-"));
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await mkdir(path.join(gameRoot, "game", "assets"), { recursive: true });
  await write(path.join(gameRoot, "game", "project.txt"), "project");
  await write(path.join(gameRoot, "game", "assets", "player.asset"), "asset");

  const artifact = await createGameArtifactManifest(gameRoot, {
    engine: GAME_ENGINES.UNITY,
    artifactName: "Test Game"
  });

  assert.equal(artifact.engine, GAME_ENGINES.UNITY);
  assert.equal(artifact.fileCount, 2);
  const manifest = JSON.parse(await readFile(path.join(gameRoot, artifact.manifest), "utf8"));
  assert.equal(manifest.engine, GAME_ENGINES.UNITY);
  assert.equal(manifest.fileCount, 2);
  assert.ok(manifest.files.some(file => file.path === "game/assets/player.asset"));

  await assert.rejects(
    () => createGameArtifactManifest(gameRoot, {
      engine: GAME_ENGINES.UNITY,
      outputDir: "../outside"
    }),
    /escapes the workspace/
  );
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(process.env.RAZEKIT_DATA_DIR, { recursive: true, force: true });
});
