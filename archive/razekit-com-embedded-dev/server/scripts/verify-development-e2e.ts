/**
 * End-to-end verification of RazeKit DEV, inside this repository.
 *
 *   DEV_E2E_DATABASE_URL=postgresql://... npm run verify:development
 *
 * Two real processes, the way production runs them:
 *
 *   this process   the RazeKit API's Development router and control plane,
 *                  served over a real socket
 *   child process  the DEV worker (src/development/worker-main.ts), started
 *                  exactly as `npm run dev:worker` starts it
 *
 * They share nothing but a Postgres schema created for this run and dropped at
 * the end. Builds are driven over HTTP with the same routes the web app uses,
 * until the worker reports them verified and complete.
 *
 * Without DEV_E2E_DATABASE_URL (a LOCAL database — this creates and drops a
 * schema) the worker cannot be a separate process, since two processes cannot
 * share a memory store; the run is refused rather than quietly downgraded.
 *
 * Identity is the one thing stubbed: a header stands in for the session, since
 * the account tables belong to the marketplace. Models run as the
 * deterministic pair unless ASTRA_API_KEY and FABLE_API_KEY are both set.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const DB = process.env.DEV_E2E_DATABASE_URL || '';
const HAS_REAL_MODELS = Boolean(process.env.ASTRA_API_KEY?.trim() && process.env.FABLE_API_KEY?.trim());
// A value that must never appear in stored state or logs. Set as a provider
// key only in deterministic mode, where it is never sent anywhere.
const CANARY = HAS_REAL_MODELS ? '' : `sk-proj-e2e-canary-${randomUUID()}`;

if (!DB) {
  console.error('verify:development needs DEV_E2E_DATABASE_URL pointing at a local Postgres (a schema is created and dropped).');
  process.exit(2);
}
const host = new URL(DB).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`Refusing to run against ${host}: DEV_E2E_DATABASE_URL must be a local database.`);
  process.exit(2);
}

const schema = `dev_e2e_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rk-dev-e2e-'));

// Configured before anything reads config, exactly as the server would be.
Object.assign(process.env, {
  NODE_ENV: 'development',
  DEV_AREA_ENABLED: 'true',
  DEV_STORE: 'postgres',
  DEV_DATABASE_URL: DB,
  DEV_DB_SCHEMA: schema,
  DEV_WORKSPACE_ROOT: workspaceRoot,
  // This run inspects the built files after completion.
  DEV_KEEP_WORKSPACES: 'true',
  DEV_FUNDING: 'none',
  DEV_MODEL_MODE: HAS_REAL_MODELS ? 'real' : 'deterministic',
  DEV_LEASE_MS: '120000',
  JWT_SECRET: process.env.JWT_SECRET || `e2e-${randomUUID()}`,
  ...(CANARY ? { ASTRA_API_KEY: CANARY } : {}),
});

const express = (await import('express')).default;
const { getEngine } = await import('../src/development/bootstrap.js');
const { DevService } = await import('../src/development/service.js');
const { createDevelopmentRouter } = await import('../src/development/routes.js');
const { listTarGz } = await import('../src/development/runtime/packager.js');

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const engine = await getEngine();
const service = new DevService(engine);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = req.header('x-e2e-user');
  req.user = id ? { id, role: 'user' } : null;
  next();
});
app.use('/api/development', createDevelopmentRouter(async () => service));
const server = app.listen(0);
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/development`;

async function api(method: string, p: string, user: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-e2e-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const workerLog: string[] = [];
let worker: ChildProcess | null = null;

async function waitFor(id: string, user: string, until: (d: any) => boolean, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = (await api('GET', `/tasks/${id}/dashboard`, user)).body;
    if (until(last)) return last;
    await sleep(500);
  }
  return last;
}

try {
  console.log(`\nRazeKit DEV end-to-end (${HAS_REAL_MODELS ? 'REAL models' : 'deterministic models'}, schema ${schema})\n`);
  check('the engine is ready', engine.readiness.ready, engine.readiness.problems.join('; '));
  check('the store is Postgres', engine.store.kind === 'postgres');

  worker = spawn(process.execPath, ['--import', 'tsx', path.join(SERVER, 'src/development/worker-main.ts')], {
    cwd: SERVER,
    env: { ...process.env, DEV_WORKER_CAPACITY: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout!.on('data', (b) => workerLog.push(String(b)));
  worker.stderr!.on('data', (b) => workerLog.push(String(b)));

  // ── Website ────────────────────────────────────────────────────────────────
  const pre = await api('POST', '/tasks/analyze', 'alice', { taskType: 'website', originalRequest: 'A landing page with a navigation bar, hero section, call to action and footer.' });
  check('a website request is routed to Niomi', pre.body?.predictedAgentType === 'niomi');
  check('a budget is estimated before anything is created', pre.body?.estimatedBudget > 0);

  const refused = await api('POST', '/tasks', 'alice', { taskType: 'website', originalRequest: 'x', maxBudget: 10 });
  check('a build without autonomous authorisation is refused', refused.status === 400 && refused.body?.code === 'DEV_AUTHORIZATION_REQUIRED');

  const created = await api('POST', '/tasks', 'alice', {
    taskType: 'website',
    title: 'E2E landing page',
    originalRequest: 'A responsive landing page with a navigation bar, hero section, pricing, call to action and footer.',
    maxBudget: 25,
    acceptAutonomousExecution: true,
    acceptanceCriteria: ['Has a pricing section'],
  });
  const id = created.body?.task?.id;
  check('the task is created and owned by the caller', created.status === 201 && created.body.task.userId === 'alice');
  check('the task is scoped to the caller tenant', created.body?.task?.tenantId === 'rk-user-alice');
  check('a Niomi agent is assigned', created.body?.agent?.agentType === 'niomi');

  check("another account cannot read this account's task", (await api('GET', `/tasks/${id}`, 'mallory')).status === 404);
  check("another account's task list is empty", Array.isArray((await api('GET', '/tasks', 'mallory')).body) && (await api('GET', '/tasks', 'mallory')).body.length === 0);

  await api('POST', `/tasks/${id}/commands`, 'alice', { content: 'Make the hero dark blue' });
  const d = await waitFor(id, 'alice', (x) => ['COMPLETED', 'BLOCKED', 'STOPPED', 'DECISION NEEDED'].includes(x?.status));
  check('the build reaches COMPLETED without being touched', d?.status === 'COMPLETED', `ended at ${d?.status}: ${JSON.stringify(d?.failure ?? d?.verification?.failures ?? '')}`);
  check('progress reports 100%', d?.progress?.percent === 100);
  check('completion is gated on verification passing', d?.verification?.status === 'passed');
  check('tests were re-run by verification', Boolean(d?.verification?.checks?.some((c: any) => c.check === 'tests' && c.passed)));
  check('spend stayed inside the hard budget', Number(d?.budget?.currentSpend) <= Number(d?.budget?.maxBudget));
  check('deliverables are reported', (d?.deliverables?.length ?? 0) > 0);

  const acceptance = (await api('GET', `/tasks/${id}/acceptance`, 'alice')).body ?? [];
  check('every acceptance criterion passed', acceptance.length > 0 && acceptance.every((c: any) => c.status === 'passed'), JSON.stringify(acceptance.filter((c: any) => c.status !== 'passed')));
  check("the user's own criterion was machine-checked", acceptance.some((c: any) => c.source === 'user' && /pricing/i.test(c.text) && c.status === 'passed'));

  const task = await engine.store.getTask(id);
  const ws = task ? engine.runtime.workspaces.pathFor(task.workspaceId) : '';
  check('the build has its own workspace directory', Boolean(ws) && existsSync(ws));
  check('the page was written', existsSync(path.join(ws, 'index.html')));
  check('the build produced output', existsSync(path.join(ws, 'dist', 'index.html')));
  if (existsSync(path.join(ws, 'dist', 'index.html'))) {
    const html = await readFile(path.join(ws, 'dist', 'index.html'), 'utf8');
    check('the page has a navigation bar', /<nav/.test(html));
    check('the page has a hero section', /id="hero"/.test(html));
    check('the page has a pricing section', /id="pricing"/.test(html));
    check('the page has a call to action', /id="cta"/.test(html));
    check('the page has a footer', /<footer/.test(html));
    const css = await readFile(path.join(ws, 'dist', 'styles.css'), 'utf8');
    check('the refinement asked for mid-build is in the output', /--hero: #0b1f4d/.test(css));
  }
  const archive = existsSync(path.join(ws, 'artifacts', 'build.tar.gz')) ? await readFile(path.join(ws, 'artifacts', 'build.tar.gz')) : null;
  check('an artifact was packaged', Boolean(archive) && listTarGz(archive!).some((e) => e.path === 'index.html'));

  // ── Game ───────────────────────────────────────────────────────────────────
  const gamePre = await api('POST', '/tasks/analyze', 'alice', { taskType: 'game', originalRequest: 'A simple endless runner' });
  check('a game request is routed to Konami', gamePre.body?.predictedAgentType === 'konami');
  check('a game gets engine tools, not web tools', gamePre.body?.predictedTools?.includes('engine') && !gamePre.body?.predictedTools?.includes('deploy-web'));
  const game = await api('POST', '/tasks', 'alice', {
    taskType: 'game',
    title: 'E2E runner',
    originalRequest: 'An endless runner where the player jumps over obstacles and the score is shown.',
    maxBudget: 25,
    acceptAutonomousExecution: true,
  });
  check('a game task is owned by Konami', game.body?.agent?.agentType === 'konami');
  check('the game task has its own workspace', game.body?.agent?.workspaceId !== created.body?.agent?.workspaceId);
  const gd = await waitFor(game.body?.task?.id, 'alice', (x) => ['COMPLETED', 'BLOCKED', 'STOPPED', 'DECISION NEEDED'].includes(x?.status));
  check('the game reaches COMPLETED', gd?.status === 'COMPLETED', `ended at ${gd?.status}: ${JSON.stringify(gd?.failure ?? gd?.verification?.failures ?? '')}`);
  check('the game manifest and runtime were verified', Boolean(gd?.verification?.checks?.some((c: any) => c.check === 'engine' && c.passed)));

  // ── Cancel ─────────────────────────────────────────────────────────────────
  const doomed = await api('POST', '/tasks', 'alice', { taskType: 'app', title: 'E2E app', originalRequest: 'A to-do list app', maxBudget: 5, acceptAutonomousExecution: true });
  await api('POST', `/tasks/${doomed.body.task.id}/cancel`, 'alice');
  const cd = await waitFor(doomed.body.task.id, 'alice', (x) => x?.status === 'STOPPED', 30_000);
  check('a cancelled build stops', cd?.status === 'STOPPED');
  const settled = await (async () => {
    for (let i = 0; i < 40; i++) {
      const t = await engine.store.getTask(doomed.body.task.id);
      if (t?.funding.settlement?.status === 'settled') return true;
      await sleep(250);
    }
    return false;
  })();
  check('a cancelled build is settled by the worker', settled);

  // ── Nothing secret is kept ────────────────────────────────────────────────
  if (CANARY) {
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DB } } });
    const dump = JSON.stringify(
      await db.$queryRawUnsafe(`SELECT (SELECT json_agg(t) FROM ${schema}.tasks t) AS tasks, (SELECT json_agg(e) FROM ${schema}.events e) AS events, (SELECT json_agg(c) FROM ${schema}.changes c) AS changes, (SELECT json_agg(s) FROM ${schema}.spend s) AS spend`)
    );
    await db.$disconnect();
    check('no provider key is persisted', !dump.includes(CANARY));
    check('no provider key is in the worker logs', !workerLog.join('').includes(CANARY));
    check('no database URL is persisted', !dump.includes(DB));
  }

  const workers = await engine.store.listWorkers();
  check('the worker registered and heartbeated', workers.some((w) => w.status === 'online'));
} catch (e) {
  failures += 1;
  console.error('  FAIL  unexpected error:', e);
} finally {
  if (worker) {
    worker.kill('SIGTERM');
    await new Promise((r) => (worker!.exitCode !== null ? r(null) : worker!.once('exit', r)));
  }
  server.close();
  try {
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DB } } });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.$disconnect();
  } catch (e) {
    console.error(`  (could not drop schema ${schema}: ${(e as Error).message.split('\n')[0]})`);
  }
  await engine.store.close();
  await rm(workspaceRoot, { recursive: true, force: true });
  // Artifacts this run stored through the local storage driver.
  const privateDir = path.join(SERVER, '_storage', 'private');
  if (existsSync(privateDir)) {
    for (const f of await readdir(privateDir)) {
      if (f.startsWith('dev-artifacts__rk-user-alice__')) await rm(path.join(privateDir, f), { force: true });
    }
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  if (workerLog.length) console.error(`\nWorker output:\n${workerLog.join('').slice(-4000)}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
