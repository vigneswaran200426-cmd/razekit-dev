// Konami: engines are detected, not assumed; games are played, not inspected.
//
// The playtests here run real game code in the same contained Node process a
// build step gets — the template game that ships, and deliberately broken
// games that crash, drift, freeze, go NaN or hang.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspaces } from '../src/development/runtime/workspace.js';
import { newWorkspaceId } from '../src/development/engine/task.js';
import { runPlaytest, judgePlaytest, PLAYTEST_PATH } from '../src/development/konami/playtest.js';
import { detectEngines, chooseEngine } from '../src/development/konami/engines.js';
import { specFor, templateFiles } from '../src/development/engine/templates.js';
import { GAME_RUNTIME_PATH, GAME_RUNTIME_SOURCE } from '../src/development/engine/gameRuntime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'rk-konami-'));
after(() => rm(root, { recursive: true, force: true }));
const ws = new Workspaces(root);

const manifest = (over: any = {}) =>
  JSON.stringify({ name: 'T', entry: 'index.html', runtime: 'razekit-game-runtime@1.0.0', width: 800, height: 300, controls: { jump: ['Space'], restart: ['KeyR'] }, simulation: { module: 'game.mjs', factory: 'createGame' }, ...over });

/** A built game: the given sources placed in dist/, as the build step would. */
async function built(files: Record<string, string>, gameJson = manifest()) {
  const id = newWorkspaceId();
  await ws.replaceSource(id, [
    { path: `dist/${GAME_RUNTIME_PATH}`, content: GAME_RUNTIME_SOURCE },
    { path: 'dist/game.json', content: gameJson },
    ...Object.entries(files).map(([p, content]) => ({ path: `dist/${p}`, content })),
  ]);
  return id;
}

const runner = (body: string) => `
import { createRng } from './vendor/razekit-game-runtime.mjs';
export function createGame({ seed = 1 } = {}) {
  let t = 0; const rng = createRng(seed); const state = { x: 0, t: 0, over: false };
  function step(dt, input = {}) { ${body} return state; }
  return { state, step };
}`;

test('the shipped template game is played headlessly and passes', async () => {
  const files = templateFiles(specFor('game', 'Runner', 'An endless runner game.', []));
  const game = files.find((f) => f.path === 'game.mjs')!;
  const gameJson = files.find((f) => f.path === 'game.json')!;
  assert.deepEqual(JSON.parse(gameJson.content).simulation, { module: 'game.mjs', factory: 'createGame' }, 'the template declares its simulation');
  const id = await built({ 'game.mjs': game.content }, gameJson.content);
  const r = await runPlaytest(ws, id, 'dist');
  assert.equal(r.ok, true, r.problems.join(' '));
  assert.equal(r.deterministic, true);
  assert.ok(r.restarts! > 0, 'the scripted player dies and restarts: collisions really happen');
  assert.ok(r.averageMs! < 4);
  assert.equal(await ws.readText(id, PLAYTEST_PATH), null, 'the playtest script does not stay in the build');
});

test('a game that crashes, drifts, freezes, goes NaN or hangs fails its playtest with the reason', async () => {
  const cases: [string, string, RegExp][] = [
    ['crash', `t++; if (t > 500) throw new Error('boom at 500'); state.x += dt;`, /failed while being played: boom at 500/],
    ['drift', `state.x += Math.random();`, /cannot be replayed/],
    ['frozen', ``, /looks frozen/],
    ['nan', `state.x += dt; if (state.x > 1) state.x = NaN;`, /NaN or infinite/],
    ['slow', `const end = Date.now() + 8; while (Date.now() < end) {} state.x += dt;`, /over the 4 ms budget/],
  ];
  for (const [name, body, expected] of cases) {
    const id = await built({ 'game.mjs': runner(body) });
    const r = await runPlaytest(ws, id, 'dist', { timeoutMs: 120_000 });
    assert.equal(r.ok, false, name);
    assert.match(r.problems.join(' '), expected, name);
  }
  const hang = await built({ 'game.mjs': runner(`while (true) {}`) });
  const r = await runPlaytest(ws, hang, 'dist', { timeoutMs: 3_000 });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /did not finish in time/);
});

test('a game that does not declare its simulation cannot be played, and says how to fix it', async () => {
  const id = await built({ 'game.mjs': runner('state.x += dt;') }, manifest({ simulation: undefined }));
  const r = await runPlaytest(ws, id, 'dist');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /must declare "simulation"/);
  const escape = await built({ 'game.mjs': runner('state.x += dt;') }, manifest({ simulation: { module: '../../../etc/passwd', factory: 'x' } }));
  assert.match((await runPlaytest(ws, escape, 'dist')).problems[0], /not a valid path/);
});

test('game code in a playtest is contained: it cannot read outside its workspace', async () => {
  const id = await built({ 'game.mjs': `import { readFileSync } from 'node:fs';\nexport function createGame(){ readFileSync('/etc/hostname'); return { state: {}, step(){ return {}; } }; }` });
  const r = await runPlaytest(ws, id, 'dist');
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /ERR_ACCESS_DENIED|permission|access/i);
});

test('judging: no report is a failure, never a pass', () => {
  assert.equal(judgePlaytest(null).ok, false);
  assert.equal(judgePlaytest({ ok: false, problems: ['x'] }).problems[0], 'x');
});

test('engines are detected, not assumed; only a buildable engine is accepted', async () => {
  const none = await detectEngines({ probe: async () => null, env: {}, fileExists: async () => false });
  const byId = Object.fromEntries(none.map((e) => [e.id, e]));
  assert.equal(byId.razekit.available && byId.razekit.buildable, true);
  for (const id of ['godot', 'unity', 'unreal']) {
    assert.equal(byId[id].available, false, id);
    assert.match(byId[id].reason, /not installed/, id);
  }
  const present = await detectEngines({
    probe: async () => '4.3.stable.official',
    env: { DEV_UNITY_EDITOR: '/opt/unity/Editor/Unity', DEV_UNREAL_ROOT: '/opt/ue' },
    fileExists: async () => true,
  });
  const g = present.find((e) => e.id === 'godot')!;
  assert.equal(g.available, true);
  assert.equal(g.version, '4.3.stable.official');
  assert.equal(g.buildable, false, 'found is not the same as able to build');
  assert.match(present.find((e) => e.id === 'unity')!.reason!, /licence is required and is not verified/);

  assert.ok('engine' in chooseEngine(undefined, none), 'default is the RazeKit runtime');
  assert.match((chooseEngine('unreal', none) as any).refused, /cannot build games on this deployment yet/);
  assert.match((chooseEngine('cryengine', none) as any).refused, /Unknown engine/);
});
