// Running a workspace script, as contained as a plain process can be.
//
// This is the LOCAL runtime. It is not a sandbox, and nothing here claims it
// is: it runs on the worker's own kernel. What it does do:
//
//   • Node's permission model: the process may read and write only inside its
//     workspace, and may not spawn children, start workers or load addons. A
//     build that tries to read ../another-build or /proc/self/environ gets
//     ERR_ACCESS_DENIED.
//   • An environment built from nothing. The worker's own variables — database
//     URLs, provider keys — are never inherited, so there is nothing to find.
//   • No shell. The argv is the broker's, passed straight to execFile.
//   • A wall-clock timeout that kills, a memory ceiling, and output capped so a
//     runaway print loop cannot fill the worker's memory.
//
// What it cannot do is stop network access or a native-code escape. That needs
// a real sandbox (a container or microVM per build), which is why production
// refuses this runtime — see ../config.ts.
import { spawn } from 'node:child_process';
import { boundOutput } from '../engine/trust.js';

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface RunOptions {
  cwd: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes?: number;
  memoryMb?: number;
}

// Stable as --permission from Node 22.13; before that (Node 20) it is
// --experimental-permission. Detected rather than assumed, so the same code is
// contained on every Node version the repository supports.
export const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

export function sandboxedNodeArgs(cwd: string, args: string[], memoryMb = 256): string[] {
  return [
    PERMISSION_FLAG,
    `--allow-fs-read=${cwd}`,
    `--allow-fs-write=${cwd}`,
    `--max-old-space-size=${memoryMb}`,
    '--disable-proto=throw',
    ...args,
  ];
}

export function runNode(opts: RunOptions): Promise<ProcessResult> {
  const max = opts.maxOutputBytes ?? 256_000;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, sandboxedNodeArgs(opts.cwd, opts.args, opts.memoryMb), {
      cwd: opts.cwd,
      shell: false,
      // Built from nothing: no variable of the worker's own reaches the build.
      env: { PATH: '/usr/bin:/bin', HOME: opts.cwd, NODE_ENV: 'test', LANG: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const collect = (buf: Buffer) => {
      if (size >= max) {
        truncated = true;
        return;
      }
      const slice = buf.subarray(0, max - size);
      chunks.push(slice);
      size += slice.length;
      if (slice.length < buf.length) truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, extra = '') => {
      clearTimeout(timer);
      let output = Buffer.concat(chunks).toString('utf8') + extra;
      if (truncated) output += '\n[output truncated]';
      if (timedOut) output += `\n[killed after ${opts.timeoutMs} ms]`;
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - started, output: boundOutput(output) });
    };
    child.on('error', (e) => finish(null, null, `\n[failed to start: ${e.message}]`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
