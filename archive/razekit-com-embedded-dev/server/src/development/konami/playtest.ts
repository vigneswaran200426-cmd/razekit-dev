// Headless playtest: the built game's own simulation, actually played.
//
// A RazeKit game declares its simulation in game.json:
//   "simulation": { "module": "game.mjs", "factory": "createGame" }
// where factory({ seed }) returns an object with step(dt, input) that returns
// (or exposes as .state) the game state. The playtest imports that module
// FROM THE BUILT OUTPUT — the code that ships — inside the same contained
// process as every other build step, and plays it: a minute of game time at
// 60 steps a second, pressing the game's own declared controls on a seeded
// schedule. It checks what a person watching could not miss:
//   • it never throws, and no number in the state becomes NaN or infinite;
//   • the same seed and the same inputs give the same final state (replay);
//   • the state keeps changing (the game is not frozen);
//   • a simulation step stays within budget (it could run at 60 fps).
// This is evidence the game runs. It is not a claim that the game is fun.
import type { Workspaces } from '../runtime/workspace.js';
import { runNode, type ProcessResult } from '../runtime/process.js';
import { safeRelativePath } from '../engine/paths.js';

/** RazeKit's file, written for the run and removed after. Never the build's. */
export const PLAYTEST_PATH = 'vendor/razekit-playtest.mjs';
export const PLAYTEST_FRAMES = 3600;
export const STEP_BUDGET_MS = { average: 4, worst: 50 };

const MARKER = 'RAZEKIT_PLAYTEST ';

export const PLAYTEST_SOURCE = `// RazeKit headless playtest. Provided by RazeKit; do not edit.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [outputDir, framesArg] = process.argv.slice(2);
const frames = Math.min(20000, Math.max(60, Number(framesArg) || 3600));
const report = (r) => { process.stdout.write('${MARKER}' + JSON.stringify(r) + '\\n'); };

let manifest;
try { manifest = JSON.parse(readFileSync(path.join(outputDir, 'game.json'), 'utf8')); }
catch { report({ ok: false, problems: ['game.json could not be read.'] }); process.exit(1); }
const sim = manifest.simulation || {};
const controls = Object.keys(manifest.controls || {});
const restartKey = controls.find((c) => /restart|retry|reset/i.test(c));
const playKeys = controls.filter((c) => c !== restartKey);

let factory;
try {
  const mod = await import(pathToFileURL(path.resolve(outputDir, sim.module)).href);
  factory = mod[sim.factory || 'createGame'];
} catch (e) {
  report({ ok: false, problems: ['The simulation module could not be loaded: ' + String(e && e.message || e).slice(0, 300)] }); process.exit(1);
}
if (typeof factory !== 'function') { report({ ok: false, problems: [(sim.factory || 'createGame') + ' is not exported by ' + sim.module + '.'] }); process.exit(1); }

function schedule(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function finite(v, depth = 0) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v && typeof v === 'object' && depth < 6) return Object.values(v).every((x) => finite(x, depth + 1));
  return true;
}
function play(seed) {
  const game = factory({ seed });
  if (!game || typeof game.step !== 'function') throw new Error('the factory must return an object with step(dt, input)');
  const press = schedule(seed);
  const dt = 1 / 60;
  let state = game.state, prev = '', changes = 0, restarts = 0, total = 0, worst = 0;
  for (let i = 0; i < frames; i++) {
    const input = {};
    for (const k of playKeys) input[k] = press() < 0.08;
    const t = performance.now();
    state = game.step(dt, input) ?? game.state;
    const took = performance.now() - t;
    total += took; worst = Math.max(worst, took);
    if (state && state.over && restartKey) { restarts++; state = game.step(dt, { [restartKey]: true }) ?? game.state; }
    if (!finite(state)) throw new Error('the state holds a NaN or infinite number at step ' + i);
    const snap = JSON.stringify(state);
    if (snap !== prev) changes++;
    prev = snap;
  }
  return { hash: createHash('sha256').update(prev).digest('hex'), changes, restarts, averageMs: total / frames, worstMs: worst };
}

try {
  const a = play(42), b = play(42), c = play(7);
  report({ ok: true, frames, first: a, replay: b, other: c });
} catch (e) {
  report({ ok: false, problems: ['The game failed while being played: ' + String(e && e.message || e).slice(0, 300)] });
  process.exit(1);
}
`;

export interface PlaytestReport {
  ok: boolean;
  problems: string[];
  frames?: number;
  averageMs?: number;
  worstMs?: number;
  restarts?: number;
  deterministic?: boolean;
}

/** Turns the script's raw result into pass/fail with reasons. */
export function judgePlaytest(raw: any, frames = PLAYTEST_FRAMES): PlaytestReport {
  if (!raw || raw.ok !== true) return { ok: false, problems: raw?.problems?.length ? raw.problems : ['The playtest did not report a result.'] };
  const problems: string[] = [];
  const deterministic = raw.first.hash === raw.replay.hash;
  if (!deterministic) problems.push('The same seed and inputs gave a different result: the game cannot be replayed.');
  if (raw.first.changes < frames * 0.5) problems.push(`The game state changed in only ${raw.first.changes} of ${frames} steps: it looks frozen.`);
  const averageMs = Math.max(raw.first.averageMs, raw.other.averageMs);
  const worstMs = Math.max(raw.first.worstMs, raw.other.worstMs);
  if (averageMs > STEP_BUDGET_MS.average) problems.push(`A simulation step averages ${averageMs.toFixed(2)} ms, over the ${STEP_BUDGET_MS.average} ms budget.`);
  if (worstMs > STEP_BUDGET_MS.worst) problems.push(`The slowest step took ${worstMs.toFixed(1)} ms, over the ${STEP_BUDGET_MS.worst} ms budget.`);
  return { ok: problems.length === 0, problems, frames, averageMs, worstMs, restarts: raw.first.restarts, deterministic };
}

/** Plays the built game inside the workspace's containment. */
export async function runPlaytest(
  ws: Workspaces,
  workspaceId: string,
  outputDir: string,
  opts: { memoryMb?: number; timeoutMs?: number; invoke?: (argv: string[], timeoutMs: number) => Promise<ProcessResult> } = {}
): Promise<PlaytestReport> {
  const raw = await ws.readText(workspaceId, `${outputDir}/game.json`, 64_000);
  let manifest: any = null;
  try {
    manifest = raw ? JSON.parse(raw) : null;
  } catch {
    /* reported below */
  }
  if (!manifest?.simulation) return { ok: false, problems: ['game.json must declare "simulation": { "module", "factory" } so the game can be played headlessly.'] };
  try {
    safeRelativePath(manifest.simulation.module);
  } catch {
    return { ok: false, problems: ['game.json simulation.module is not a valid path.'] };
  }
  const dir = safeRelativePath(outputDir);
  await ws.writeFile(workspaceId, PLAYTEST_PATH, PLAYTEST_SOURCE);
  try {
    const argv = [PLAYTEST_PATH, dir, String(PLAYTEST_FRAMES)];
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const r = opts.invoke
      ? await opts.invoke(argv, timeoutMs)
      : await runNode({ cwd: ws.pathFor(workspaceId), args: argv, timeoutMs, memoryMb: opts.memoryMb ?? 256 });
    if (r.timedOut) return { ok: false, problems: ['The playtest did not finish in time: the game may hang.'] };
    const line = r.output.split('\n').find((l) => l.startsWith(MARKER));
    let parsed: any = null;
    try {
      parsed = line ? JSON.parse(line.slice(MARKER.length)) : null;
    } catch {
      /* no result */
    }
    return judgePlaytest(parsed);
  } finally {
    await ws.removeFile(workspaceId, PLAYTEST_PATH).catch(() => undefined);
  }
}
