// RazeKit DEV build runner: the program inside each per-step Fargate task.
//
// It is given two short-lived pre-signed URLs and nothing else — no AWS
// credentials, no RazeKit secrets. It downloads the workspace, runs the ONE
// broker-built `node` invocation described in razekit-job.json under Node's
// permission model (the workspace only, no child processes, an environment
// built from nothing), then uploads the workspace and the result.
//
// Exit codes: 0 when the invocation ran (whatever its own result), 2 when the
// runner itself could not do its job. The caller treats 2 as infrastructure.
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';

export const JOB_FILE = 'razekit-job.json';
export const RESULT_FILE = 'razekit-result.json';
const BLOCK = 512;
const MAX_OUTPUT = 256_000;

const octal = (v, w) => v.toString(8).padStart(w - 1, '0') + '\0';
function header(name, size) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Path too long: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}
export function pack(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(header(e.path, e.data.length), e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts));
}
export function unpack(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 200_000_000 });
  const out = [];
  for (let off = 0; off + BLOCK <= tar.length; ) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    if (String.fromCharCode(h[156] || 48) !== '0') throw new Error(`Not a regular file: ${name}`);
    out.push({ path: name, data: Buffer.from(tar.subarray(off + BLOCK, off + BLOCK + size)) });
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
function inside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) throw new Error(`Unsafe path: ${rel}`);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error(`Unsafe path: ${rel}`);
  return full;
}
/**
 * Clears everything inside `dir` and leaves `dir` itself in place.
 *
 * On Fargate /work is a mounted volume: removing a mount point fails with EBUSY,
 * and the read-only root filesystem could not recreate it anyway. So the
 * workspace is emptied, never removed. Links are removed, never followed.
 */
export async function emptyDir(dir, fs = { readdir, rm }) {
  for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
}
async function collect(root, dir = root, out = []) {
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    const st = await lstat(full);
    if (st.isDirectory()) await collect(root, full, out);
    else if (st.isFile()) out.push({ path: path.relative(root, full).split(path.sep).join('/'), data: await readFile(full) });
    // Links and special files are left behind, never followed.
  }
  return out;
}

function run(work, job) {
  const flag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  const args = [flag, `--allow-fs-read=${work}`, `--allow-fs-write=${work}`, `--max-old-space-size=${job.memoryMb || 256}`, '--disable-proto=throw', ...job.argv];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: work,
      shell: false,
      env: { PATH: '/usr/bin:/bin', HOME: work, NODE_ENV: 'test', LANG: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let size = 0;
    const take = (b) => {
      if (size < MAX_OUTPUT) chunks.push(b.subarray(0, MAX_OUTPUT - size));
      size += b.length;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1, job.timeoutMs));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, output: Buffer.concat(chunks).toString('utf8') });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut: false, output: String(e.message) });
    });
  });
}

export async function main(env = process.env) {
  const work = path.resolve(env.WORK_DIR || '/work');
  const got = await fetch(env.INPUT_URL);
  if (!got.ok) throw new Error(`Could not download the workspace (HTTP ${got.status}).`);
  // A no-op when the mount is there; creates the directory where it is not.
  await mkdir(work, { recursive: true });
  await emptyDir(work);
  for (const e of unpack(Buffer.from(await got.arrayBuffer()))) {
    const target = inside(work, e.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, e.data);
  }
  const job = JSON.parse(await readFile(path.join(work, JOB_FILE), 'utf8'));
  await rm(path.join(work, JOB_FILE), { force: true });
  if (!Array.isArray(job.argv) || !job.argv.every((a) => typeof a === 'string')) throw new Error('The job is malformed.');

  const started = Date.now();
  const result = await run(work, job);
  const files = await collect(work);
  files.push({ path: RESULT_FILE, data: Buffer.from(JSON.stringify({ ...result, durationMs: Date.now() - started })) });
  const put = await fetch(env.OUTPUT_URL, { method: 'PUT', body: pack(files), headers: { 'content-type': 'application/gzip' } });
  if (!put.ok) throw new Error(`Could not upload the result (HTTP ${put.status}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`razekit-runner: ${e && e.message}\n`);
      process.exit(2);
    }
  );
}
