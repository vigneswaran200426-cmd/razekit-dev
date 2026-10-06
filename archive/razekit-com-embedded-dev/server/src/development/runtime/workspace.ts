// Workspaces: one directory per build, and nothing outside it.
//
// A workspace id is validated before it becomes a path, every file is written
// through resolveInside(), and a scan refuses to follow or count symbolic
// links — a link is how a build that may only write inside its own directory
// would otherwise reach someone else's.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DevError, ERR } from '../engine/errors.js';
import { resolveInside } from '../engine/paths.js';
import type { FileRecord, PlannedFile } from '../engine/types.js';

const WORKSPACE_ID = /^ws_[a-f0-9]{32}$/;
export const ARTIFACTS_DIR = 'artifacts';

export interface ScanResult {
  files: FileRecord[];
  totalBytes: number;
  /** Anything that is not a plain file or directory: links, sockets, devices. */
  irregular: string[];
}

export class Workspaces {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  pathFor(workspaceId: string): string {
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new DevError(ERR.PATH, `Invalid workspace id ${JSON.stringify(workspaceId)}.`);
    }
    return path.join(this.root, workspaceId);
  }

  async ensure(workspaceId: string): Promise<string> {
    const dir = this.pathFor(workspaceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Replaces the workspace's source with exactly these files.
   *
   * Everything from the previous attempt is removed first, except earlier
   * artifacts. A file the new attempt no longer writes must not survive to
   * make a test pass that the new code would fail.
   */
  async replaceSource(workspaceId: string, files: PlannedFile[]): Promise<FileRecord[]> {
    const dir = await this.ensure(workspaceId);
    for (const entry of await readdir(dir)) {
      if (entry === ARTIFACTS_DIR) continue;
      await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    const written: FileRecord[] = [];
    for (const f of files) {
      const target = resolveInside(dir, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(f.content, 'utf8');
      await writeFile(target, bytes, { mode: 0o600 });
      written.push({ path: f.path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return written;
  }

  async readText(workspaceId: string, rel: string, max = 2_000_000): Promise<string | null> {
    const full = resolveInside(this.pathFor(workspaceId), rel);
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.size > max) return null;
      return await readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  async readBytes(workspaceId: string, rel: string): Promise<Buffer | null> {
    const full = resolveInside(this.pathFor(workspaceId), rel);
    try {
      const st = await lstat(full);
      if (!st.isFile()) return null;
      return await readFile(full);
    } catch {
      return null;
    }
  }

  /** Every regular file under `sub`, hashed, with anything irregular reported rather than followed. */
  async scan(workspaceId: string, sub = ''): Promise<ScanResult> {
    const base = this.pathFor(workspaceId);
    const start = sub ? resolveInside(base, sub) : base;
    const files: FileRecord[] = [];
    const irregular: string[] = [];
    let totalBytes = 0;

    async function walk(dir: string) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        const full = path.join(dir, name);
        const rel = path.relative(base, full).split(path.sep).join('/');
        const st = await lstat(full);
        if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
          irregular.push(rel);
        } else if (st.isDirectory()) {
          await walk(full);
        } else {
          const bytes = await readFile(full);
          totalBytes += bytes.length;
          files.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes) });
        }
      }
    }
    await walk(start);
    return { files, totalBytes, irregular };
  }

  /**
   * Replaces the workspace's files (all but artifacts/) with `entries`, byte
   * for byte. Used when a build ran elsewhere and its workspace came back.
   * Every path goes through resolveInside first; one bad path refuses all.
   */
  async restore(workspaceId: string, entries: { path: string; data: Buffer }[]) {
    const dir = await this.ensure(workspaceId);
    const targets = entries.map((e) => ({ target: resolveInside(dir, e.path), data: e.data }));
    for (const entry of await readdir(dir)) {
      if (entry === ARTIFACTS_DIR) continue;
      await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    for (const t of targets) {
      await mkdir(path.dirname(t.target), { recursive: true });
      await writeFile(t.target, t.data, { mode: 0o600 });
    }
  }

  /** Writes one RazeKit-owned file (never a build's source) inside the workspace. */
  async writeFile(workspaceId: string, rel: string, content: string) {
    const target = resolveInside(await this.ensure(workspaceId), rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
  }

  /** Removes one file inside the workspace. Never a directory, never outside. */
  async removeFile(workspaceId: string, rel: string) {
    await rm(resolveInside(this.pathFor(workspaceId), rel), { force: true });
  }

  async remove(workspaceId: string) {
    await rm(this.pathFor(workspaceId), { recursive: true, force: true });
  }
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
