// Konami's game engines, and whether each can actually build here.
//
// Konami core never shells out to an engine itself: each engine is an adapter
// that says what it is, what it can target, and — checked on the worker, not
// assumed — whether its toolchain is really present. An engine that is not
// installed is reported unavailable with the reason, and a build that needs it
// is refused before anything is paid for, never "simulated".
//
//   razekit  The RazeKit Game Runtime (web). Ships with DEV, always present,
//            and the one engine builds run on today: the build, the manifest
//            check and the headless playtest are all real.
//   godot    Detected by running `godot --version` (or DEV_GODOT_BIN).
//   unity    Detected from DEV_UNITY_EDITOR (the editor executable). A found
//            editor is not proof of a licence; that is reported, not assumed.
//   unreal   Detected from DEV_UNREAL_ROOT (Engine/Build/BatchFiles/RunUAT.sh).
//
// Detection only answers "is it there". Driving Godot, Unity or Unreal builds
// needs worker images with those toolchains (and, for Unity and Unreal, their
// licences); until a worker has one, those engines stay unavailable.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { GAME_RUNTIME_ID, GAME_RUNTIME_VERSION } from '../engine/gameRuntime.js';

export type EngineId = 'razekit' | 'godot' | 'unity' | 'unreal';

export interface EngineStatus {
  id: EngineId;
  name: string;
  available: boolean;
  /** True only for engines DEV can drive a build on end to end today. */
  buildable: boolean;
  version: string | null;
  targets: string[];
  reason: string | null;
}

type Probe = (bin: string, args: string[]) => Promise<string | null>;

const run: Probe = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000, env: { PATH: process.env.PATH ?? '' } }, (err, stdout) => resolve(err ? null : String(stdout).trim().slice(0, 200)));
  });

const exists = async (p: string) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

export async function detectEngines(deps: { probe?: Probe; env?: Record<string, string | undefined>; fileExists?: (p: string) => Promise<boolean> } = {}): Promise<EngineStatus[]> {
  const probe = deps.probe ?? run;
  const env = deps.env ?? process.env;
  const has = deps.fileExists ?? exists;

  const godotBin = env.DEV_GODOT_BIN || 'godot';
  const godotVersion = await probe(godotBin, ['--version', '--headless']);

  const unityEditor = env.DEV_UNITY_EDITOR || '';
  const unityFound = unityEditor ? await has(unityEditor) : false;

  const unrealRoot = env.DEV_UNREAL_ROOT || '';
  const unrealFound = unrealRoot ? await has(path.join(unrealRoot, 'Engine/Build/BatchFiles/RunUAT.sh')) : false;

  const notDriven = 'Found on this worker, but DEV does not yet drive builds with it; a worker image with its build pipeline is needed.';
  return [
    { id: 'razekit', name: 'RazeKit Game Runtime', available: true, buildable: true, version: GAME_RUNTIME_ID, targets: ['web'], reason: null },
    {
      id: 'godot',
      name: 'Godot',
      available: Boolean(godotVersion),
      buildable: false,
      version: godotVersion,
      targets: ['web', 'windows', 'linux', 'macos', 'android'],
      reason: godotVersion ? notDriven : `Godot is not installed on this worker (${godotBin} --version did not run).`,
    },
    {
      id: 'unity',
      name: 'Unity',
      available: unityFound,
      buildable: false,
      version: null,
      targets: ['web', 'windows', 'linux', 'macos', 'android', 'ios'],
      reason: unityFound ? `${notDriven} A licence is required and is not verified.` : 'The Unity editor is not installed on this worker.',
    },
    {
      id: 'unreal',
      name: 'Unreal Engine',
      available: unrealFound,
      buildable: false,
      version: null,
      targets: ['windows', 'linux', 'macos', 'android', 'ios'],
      reason: unrealFound ? notDriven : 'Unreal Engine is not installed on this worker.',
    },
  ];
}

/** The engine a game build runs on, or the reason it cannot, before payment. */
export function chooseEngine(requested: unknown, engines: EngineStatus[]): { engine: EngineStatus } | { refused: string } {
  const id = typeof requested === 'string' && requested.trim() ? requested.trim().toLowerCase() : 'razekit';
  const engine = engines.find((e) => e.id === id);
  if (!engine) return { refused: `Unknown engine "${String(requested).slice(0, 40)}". Available: ${engines.filter((e) => e.buildable).map((e) => e.id).join(', ')}.` };
  if (!engine.buildable) return { refused: `${engine.name} cannot build games on this deployment yet: ${engine.reason}` };
  return { engine };
}

export const RAZEKIT_ENGINE_VERSION = GAME_RUNTIME_VERSION;
