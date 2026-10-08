// The `engine` tool: is this a valid RazeKit game?
//
// A game build declares itself in game.json. This checks the declaration
// against the facts: the entry page exists in the built output, the runtime it
// names is the one RazeKit ships, and the runtime file in the output is
// byte-for-byte RazeKit's — not a copy the build edited.
import { GAME_RUNTIME_ID, GAME_RUNTIME_PATH, GAME_RUNTIME_SHA256 } from '../engine/gameRuntime.js';
import { safeRelativePath } from '../engine/paths.js';
import { sha256, type Workspaces } from './workspace.js';

export async function checkGameManifest(ws: Workspaces, workspaceId: string, outputDir: string): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const raw = await ws.readText(workspaceId, `${outputDir}/game.json`, 64_000);
  if (raw === null) return { ok: false, problems: [`${outputDir}/game.json is missing.`] };

  let manifest: any;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['game.json is not valid JSON.'] };
  }

  if (typeof manifest?.name !== 'string' || !manifest.name.trim()) problems.push('game.json needs a name.');
  if (manifest?.runtime !== GAME_RUNTIME_ID) problems.push(`game.json must declare runtime "${GAME_RUNTIME_ID}".`);
  for (const dim of ['width', 'height'] as const) {
    const v = manifest?.[dim];
    if (!Number.isInteger(v) || v < 64 || v > 4096) problems.push(`game.json ${dim} must be a whole number between 64 and 4096.`);
  }
  if (typeof manifest?.controls !== 'object' || manifest.controls === null || !Object.keys(manifest.controls).length) {
    problems.push('game.json must declare its controls.');
  }

  try {
    const entry = safeRelativePath(manifest?.entry);
    if ((await ws.readText(workspaceId, `${outputDir}/${entry}`)) === null) problems.push(`The entry ${entry} is not in the built output.`);
  } catch {
    problems.push('game.json entry is not a valid path.');
  }

  const runtime = await ws.readBytes(workspaceId, `${outputDir}/${GAME_RUNTIME_PATH}`);
  if (!runtime) problems.push(`The RazeKit runtime is not in the built output (${GAME_RUNTIME_PATH}).`);
  else if (sha256(runtime) !== GAME_RUNTIME_SHA256) problems.push('The RazeKit runtime in the output was modified.');

  return { ok: problems.length === 0, problems };
}
