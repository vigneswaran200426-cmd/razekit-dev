// The RazeKit Game Runtime, as shipped into every Konami build.
//
// A small, dependency-free foundation every game is built on, so a game build
// spends its budget on the game rather than re-deriving a frame loop:
//
//   createLoop     fixed-timestep simulation with an accumulator, so physics
//                  behaves the same at 30 fps and 144 fps, and a long stall
//                  cannot make the game "catch up" by simulating seconds at once
//   createInput    keyboard, pointer and touch mapped onto named actions, with
//                  held and just-pressed queries
//   aabb           axis-aligned box overlap
//   createRng      a seeded generator, so a level can be replayed exactly and
//                  game logic can be tested deterministically
//
// It is RazeKit's file, not the model's. The executor writes it before the
// build's own files, a build may import it but may not overwrite it, and the
// engine check verifies its checksum — so "built on the RazeKit runtime" is a
// fact the verifier checks rather than a claim the model makes.
import { createHash } from 'node:crypto';

export const GAME_RUNTIME_PATH = 'vendor/razekit-game-runtime.mjs';
export const GAME_RUNTIME_VERSION = '1.0.0';
export const GAME_RUNTIME_ID = `razekit-game-runtime@${GAME_RUNTIME_VERSION}`;

export const GAME_RUNTIME_SOURCE = `// RazeKit Game Runtime ${GAME_RUNTIME_VERSION}. Provided by RazeKit; do not edit.
export const RUNTIME_VERSION = '${GAME_RUNTIME_VERSION}';

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function createRng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, range: (lo, hi) => lo + (hi - lo) * next(), int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()) };
}

export function createLoop({ step, render = () => {}, fixedDt = 1 / 60, maxFrame = 0.25 }) {
  let acc = 0;
  let last = null;
  let running = false;
  let handle = null;
  const loop = {
    tick(timeSeconds) {
      if (last === null) last = timeSeconds;
      const frame = Math.min(Math.max(timeSeconds - last, 0), maxFrame);
      last = timeSeconds;
      acc += frame;
      let steps = 0;
      while (acc >= fixedDt) {
        step(fixedDt);
        acc -= fixedDt;
        steps += 1;
      }
      render(acc / fixedDt);
      return steps;
    },
    start() {
      if (running || typeof requestAnimationFrame !== 'function') return;
      running = true;
      const frame = (ms) => {
        if (!running) return;
        loop.tick(ms / 1000);
        handle = requestAnimationFrame(frame);
      };
      handle = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (handle !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
      handle = null;
      last = null;
      acc = 0;
    },
  };
  return loop;
}

export function createInput(bindings) {
  const held = new Set();
  const pressed = new Set();
  const byKey = new Map();
  for (const [action, keys] of Object.entries(bindings)) for (const k of keys) byKey.set(k, action);
  const down = (action) => { if (!held.has(action)) pressed.add(action); held.add(action); };
  const up = (action) => { held.delete(action); };
  const onKeyDown = (e) => { const a = byKey.get(e.code); if (a) { e.preventDefault?.(); down(a); } };
  const onKeyUp = (e) => { const a = byKey.get(e.code); if (a) up(a); };
  const pointerAction = byKey.get('Pointer');
  const onPointerDown = () => { if (pointerAction) down(pointerAction); };
  const onPointerUp = () => { if (pointerAction) up(pointerAction); };
  return {
    isDown: (action) => held.has(action),
    wasPressed: (action) => pressed.has(action),
    press: down,
    release: up,
    endFrame: () => pressed.clear(),
    attach(target) {
      target.addEventListener('keydown', onKeyDown);
      target.addEventListener('keyup', onKeyUp);
      target.addEventListener('pointerdown', onPointerDown);
      target.addEventListener('pointerup', onPointerUp);
    },
    detach(target) {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointerup', onPointerUp);
    },
  };
}
`;

export const GAME_RUNTIME_SHA256 = createHash('sha256').update(GAME_RUNTIME_SOURCE).digest('hex');

export const GAME_RUNTIME_DESCRIPTION =
  'RazeKit Game Runtime: createLoop({ step, render, fixedDt }), createInput(bindings) with isDown/wasPressed/endFrame/attach, aabb(a, b), createRng(seed), clamp.';
