// The Fargate runtime, end to end, with the real runner.
//
// AWS's control plane is faked: "ECS" starts the actual runner.mjs as a child
// process with only the two URLs it would get, and "S3" is a local HTTP server
// behind the pre-signed URLs. Everything else is real: whole builds go through
// the orchestrator, every test and build step and the game playtest run
// inside the runner, and the workspace comes back through the archive checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const { config } = await import('../src/config.js');
const { buildEngine } = await import('../src/development/bootstrap.js');
const { DevService } = await import('../src/development/service.js');
const { DevWorker } = await import('../src/development/worker.js');
const { MemoryDevStore } = await import('../src/development/store/memory.js');
const { NoFunding } = await import('../src/development/funding.js');
const { deterministicAstra, deterministicFable } = await import('../src/development/engine/deterministic.js');
const { FargateRuntime } = await import('../src/development/runtime/aws/fargate.js');
const { DevError } = await import('../src/development/engine/errors.js');
const { newWorkspaceId } = await import('../src/development/engine/task.js');

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/development/runtime/aws/runner.mjs');
const root = await mkdtemp(path.join(os.tmpdir(), 'rk-fargate-'));

// ── "S3" ─────────────────────────────────────────────────────────────────────
const objects = new Map<string, Buffer>();
let failPuts = false;
const s3 = http.createServer((req, res) => {
  const key = decodeURIComponent(req.url!.slice(3));
  if (req.method === 'GET') {
    const body = objects.get(key);
    res.writeHead(body ? 200 : 404).end(body);
  } else if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      if (failPuts) return void res.writeHead(500).end();
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200).end();
    });
  } else res.writeHead(405).end();
});
await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
const s3url = `http://127.0.0.1:${(s3.address() as AddressInfo).port}/o/`;
after(async () => {
  s3.close();
  await rm(root, { recursive: true, force: true });
});

const storage = {
  put: async (k: string, b: Buffer) => void objects.set(k, b),
  get: async (k: string) => objects.get(k) ?? null,
  remove: async (k: string) => void objects.delete(k),
  presignGet: async (k: string) => s3url + encodeURIComponent(k),
  presignPut: async (k: string) => s3url + encodeURIComponent(k),
};

// ── "ECS" ────────────────────────────────────────────────────────────────────
function fakeEcs(opts: { loseFirstAnswer?: boolean; never?: boolean; custom?: (env: Record<string, string>) => Promise<number> } = {}) {
  const byToken = new Map<string, string>();
  const tasks = new Map<string, { exit: number | null; child?: ChildProcess }>();
  const calls: any[] = [];
  let lost = false;
  const stops: string[] = [];
  return {
    calls,
    stops,
    started: () => tasks.size,
    async runTask(input: any) {
      calls.push(input);
      let arn = byToken.get(input.clientToken);
      if (!arn) {
        arn = `arn:aws:ecs:task/${tasks.size + 1}`;
        byToken.set(input.clientToken, arn);
        const env = Object.fromEntries(input.overrides.containerOverrides[0].environment.map((e: any) => [e.name, e.value]));
        const t: { exit: number | null; child?: ChildProcess } = { exit: null };
        tasks.set(arn, t);
        if (opts.custom) opts.custom(env).then((code) => (t.exit = code));
        else if (!opts.never) {
          const child = spawn(process.execPath, [RUNNER], {
            // Exactly what the container gets: the two URLs, a work dir. No AWS
            // credentials, no RazeKit secrets.
            env: { INPUT_URL: env.INPUT_URL, OUTPUT_URL: env.OUTPUT_URL, WORK_DIR: path.join(root, 'task', arn.split('/').pop()!), PATH: process.env.PATH! },
            stdio: 'ignore',
          });
          t.child = child;
          child.on('exit', (code) => (t.exit = code ?? 1));
        }
      }
      if (opts.loseFirstAnswer && !lost) {
        lost = true;
        throw new Error('socket hang up');
      }
      return { tasks: [{ taskArn: arn }] };
    },
    async describeTasks(input: any) {
      const t = tasks.get(input.tasks[0])!;
      return { tasks: [t.exit === null ? { lastStatus: 'RUNNING' } : { lastStatus: 'STOPPED', stopCode: 'EssentialContainerExited', containers: [{ exitCode: t.exit }] }] };
    },
    async stopTask(input: any) {
      stops.push(input.task);
      tasks.get(input.task)!.child?.kill('SIGKILL');
    },
  };
}

const settings = { cluster: 'rk-dev', taskDefinition: 'rk-dev-runner:1', containerName: 'runner', subnets: ['subnet-a'], securityGroups: ['sg-x'], prefix: 'runs' };
const runtimeWith = (ecs: any, extra: any = {}) => new FargateRuntime({ root }, { ecs, storage, settings, pollMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...extra });

async function buildOn(runtime: any, body: any) {
  const store = new MemoryDevStore();
  const engine = buildEngine(config.development, {
    store,
    runtime,
    providers: { astra: deterministicAstra(), fable: deterministicFable(), mode: 'deterministic' },
    funding: new NoFunding(),
    artifacts: null,
    production: false,
    report: () => undefined,
    notifier: null,
    github: null,
  });
  await store.init();
  const service = new DevService(engine);
  const worker = new DevWorker({ store, orchestrator: engine.orchestrator, capabilities: ['web', 'game'], capacity: 1, leaseMs: 120_000 });
  const { task } = await service.create({ id: 'alice' }, { maxBudget: 5, acceptAutonomousExecution: true, ...body });
  for (let i = 0; i < 80 && (await worker.runOnce()); i++);
  return { engine, task: (await store.getTask(task.id))! };
}

test('production accepts the Fargate runtime as isolation, and every build step runs in its own task', async () => {
  const ecs = fakeEcs();
  const { engine, task } = await buildOn(runtimeWith(ecs), { taskType: 'website', title: 'Site', originalRequest: 'A landing page with a navigation bar, hero section and footer.' });
  assert.equal(engine.readiness.mode.runtime, 'sandbox');
  const prod = buildEngine(config.development, { store: new MemoryDevStore(), runtime: runtimeWith(fakeEcs()), production: true, report: () => undefined, notifier: null, github: null });
  assert.ok(!prod.readiness.problems.some((p: string) => /runtime/i.test(p)), `production raises nothing about the runtime: ${prod.readiness.problems.join(' | ')}`);
  assert.equal(task.state, 'completed', JSON.stringify(task.failure ?? task.verification.failures));
  assert.ok(ecs.started() >= 3, `test, build and the verification re-run each ran remotely (${ecs.started()})`);
  for (const c of ecs.calls) {
    assert.equal(c.launchType, 'FARGATE');
    assert.equal(c.networkConfiguration.awsvpcConfiguration.assignPublicIp, 'DISABLED');
    assert.deepEqual(c.overrides.containerOverrides[0].environment.map((e: any) => e.name), ['INPUT_URL', 'OUTPUT_URL'], 'the task gets two URLs and nothing else');
  }
  assert.ok(task.artifact, 'packaged on the worker from what came back');
  assert.equal(objects.size, 0, 'every run object is deleted');
});

test('a game is built and played headlessly inside Fargate tasks', async () => {
  const ecs = fakeEcs();
  const { task } = await buildOn(runtimeWith(ecs), { taskType: 'game', title: 'Runner', originalRequest: 'An endless runner game with jumping.' });
  assert.equal(task.state, 'completed', JSON.stringify(task.failure ?? task.verification.failures));
  const played = task.verification.checks.find((c: any) => c.check === 'playtest');
  assert.equal(played?.passed, true, played?.evidence);
});

test('a lost answer from RunTask does not start a second task', async () => {
  const ecs = fakeEcs({ loseFirstAnswer: true });
  const rt = runtimeWith(ecs);
  const id = newWorkspaceId();
  await rt.workspaces.replaceSource(id, [{ path: 'a.mjs', content: "console.log('hi from fargate')" }]);
  const r = await (rt as any).invoke(id, ['a.mjs'], 30_000);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /hi from fargate/);
  assert.equal(ecs.calls.length, 2, 'retried');
  assert.equal(ecs.started(), 1, 'the retry found the task, it did not start another');
});

test('a task that never stops is stopped at the deadline and reported as timed out', async () => {
  const ecs = fakeEcs({ never: true });
  const rt = runtimeWith(ecs, { startGraceMs: 50 });
  const id = newWorkspaceId();
  await rt.workspaces.replaceSource(id, [{ path: 'a.mjs', content: '' }]);
  const r = await (rt as any).invoke(id, ['a.mjs'], 100);
  assert.equal(r.timedOut, true);
  assert.equal(ecs.stops.length, 1);
  assert.equal(objects.size, 0);
});

test('a runner that cannot deliver its result is an infrastructure failure, retryable', async () => {
  failPuts = true;
  try {
    const rt = runtimeWith(fakeEcs());
    const id = newWorkspaceId();
    await rt.workspaces.replaceSource(id, [{ path: 'a.mjs', content: '' }]);
    await assert.rejects((rt as any).invoke(id, ['a.mjs'], 30_000), (e: unknown) => e instanceof DevError && e.retryable && /stopped without a result/.test(e.message));
  } finally {
    failPuts = false;
  }
});

// On Fargate /work is a mounted volume over a read-only root filesystem: the
// runner may empty it but must never remove or recreate the directory itself.
test('the runner empties its work directory without ever removing the directory itself', async () => {
  const { emptyDir } = await import(pathToFileURL(RUNNER).href);
  const work = await mkdtemp(path.join(root, 'mounted-'));
  const outside = await mkdtemp(path.join(root, 'outside-'));
  await writeFile(path.join(outside, 'keep.txt'), 'not the runner\'s');
  await mkdir(path.join(work, 'old', 'deep'), { recursive: true });
  await writeFile(path.join(work, 'old', 'deep', 'x.txt'), 'stale');
  await writeFile(path.join(work, 'stale.txt'), 'stale');
  await symlink(outside, path.join(work, 'link'));
  const removed: string[] = [];
  await emptyDir(work, { readdir, rm: (p: string, o: any) => (removed.push(p), rm(p, o)) });
  assert.ok(!removed.includes(work), 'the directory itself is never removed');
  assert.ok((await stat(work)).isDirectory());
  assert.deepEqual(await readdir(work), []);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'not the runner\'s', 'a link is removed, never followed');
});

test('a run into a work directory that already exists and holds stale files returns only the workspace', async () => {
  const mounted = await mkdtemp(path.join(root, 'volume-'));
  await mkdir(path.join(mounted, 'old'), { recursive: true });
  await writeFile(path.join(mounted, 'old', 'stale.txt'), 'from before');
  const ecs = fakeEcs({
    custom: (env) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [RUNNER], { env: { INPUT_URL: env.INPUT_URL, OUTPUT_URL: env.OUTPUT_URL, WORK_DIR: mounted, PATH: process.env.PATH! }, stdio: 'ignore' });
        child.on('exit', (code) => resolve(code ?? 1));
      }),
  });
  const rt = runtimeWith(ecs);
  const id = newWorkspaceId();
  await rt.workspaces.replaceSource(id, [{ path: 'a.mjs', content: "import { writeFileSync } from 'node:fs';\nwriteFileSync('out.txt', 'ok');\n" }]);
  const r = await (rt as any).invoke(id, ['a.mjs'], 30_000);
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(await rt.workspaces.readText(id, 'out.txt'), 'ok');
  assert.equal(await rt.workspaces.readText(id, 'old/stale.txt'), null, 'nothing from before the run comes back');
  assert.ok((await stat(mounted)).isDirectory(), 'the work directory is still there');
});

test('an archive that comes back with a link or an escaping path is refused whole', async () => {
  const header = (name: string, type: string, size: number) => {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 100);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
    h.write(type, 156, 1);
    h.write('ustar\0', 257, 6);
    return h;
  };
  for (const [name, type] of [['evil-link', '2'], ['../../escape.txt', '0']]) {
    const ecs = fakeEcs({
      custom: async (env) => {
        const body = gzipSync(Buffer.concat([header(name, type, 0), Buffer.alloc(1024)]));
        await fetch(env.OUTPUT_URL, { method: 'PUT', body });
        return 0;
      },
    });
    const rt = runtimeWith(ecs);
    const id = newWorkspaceId();
    await rt.workspaces.replaceSource(id, [{ path: 'keep.txt', content: 'mine' }]);
    await assert.rejects((rt as any).invoke(id, ['a.mjs'], 30_000), (e: unknown) => e instanceof DevError, name);
    assert.equal(await rt.workspaces.readText(id, 'keep.txt'), 'mine', 'the workspace is untouched');
  }
});

test('the runtime reports what it is missing rather than failing at the first build', () => {
  const rt = new FargateRuntime({ root }, { ecs: fakeEcs() as any, storage, settings: { ...settings, subnets: [], cluster: '' } });
  assert.equal(rt.status.available, false);
  assert.match(rt.status.reason!, /missing its cluster, subnets/);
});
