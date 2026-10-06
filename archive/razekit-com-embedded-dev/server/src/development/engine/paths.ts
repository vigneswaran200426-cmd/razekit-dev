// Workspace-relative paths, and the only way one becomes a real path.
//
// Every path in a plan came from a model, and a model can be talked into
// writing "../../server/.env". A path is accepted only if it is a plain,
// relative, forward-slash path made of ordinary characters, with no parent
// segments, no hidden VCS or dependency directories, and a bounded depth.
// Anything else is refused outright, never "cleaned up": a cleaned-up hostile
// path is still a path somebody chose to attack with.
import path from 'node:path';
import { DevError, ERR } from './errors.js';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules', '.env', '.npmrc', '.ssh']);

export function unsafePath(p: string, why: string): DevError {
  return new DevError(ERR.PATH, `Refused path ${JSON.stringify(String(p).slice(0, 120))}: ${why}.`);
}

/** Validates and normalises a workspace-relative path. Throws on anything suspect. */
export function safeRelativePath(p: unknown, { maxDepth = 8 } = {}): string {
  if (typeof p !== 'string' || p.length === 0) throw unsafePath(String(p), 'not a path');
  if (p.length > 200) throw unsafePath(p, 'too long');
  if (p.includes('\0')) throw unsafePath(p, 'contains a null byte');
  if (p.includes('\\')) throw unsafePath(p, 'backslashes are not allowed');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw unsafePath(p, 'must be relative');

  const segments = p.split('/').filter((s, i, all) => !(s === '' && i === all.length - 1));
  if (segments.length > maxDepth) throw unsafePath(p, 'nested too deeply');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw unsafePath(p, 'empty, "." or ".." segments are not allowed');
    if (FORBIDDEN_SEGMENTS.has(seg.toLowerCase())) throw unsafePath(p, `${seg} is reserved`);
    if (!SEGMENT.test(seg)) throw unsafePath(p, 'only letters, digits, ".", "_" and "-" are allowed');
  }
  return segments.join('/');
}

/**
 * Resolves a validated relative path inside a workspace root.
 *
 * Validation already rules out escape; the containment check is repeated on
 * the resolved result anyway, because this is the last line before a write and
 * it costs nothing.
 */
export function resolveInside(root: string, rel: string): string {
  const clean = safeRelativePath(rel);
  const absRoot = path.resolve(root);
  const full = path.resolve(absRoot, clean);
  if (full !== absRoot && !full.startsWith(absRoot + path.sep)) throw unsafePath(rel, 'escapes the workspace');
  return full;
}
