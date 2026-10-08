// Several workers, one queue, real Postgres.
//
// Two workers with two slots each race over four builds at once. Every build
// must complete, and every phase of every build must have run exactly once —
// a build ticked by two workers at the same moment would show up as a phase
// that started twice.
//
// Runs only with DEV_TEST_DATABASE_URL (a throwaway schema is created and
// dropped).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const URL_ = process.env.DEV_TEST_DATABASE_URL || '';
const skip = URL_ ? false : 'DEV_TEST_DATABASE_URL is not set';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

const schema = `dev_workers_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let cleanup: (() => Promise<void>) | null = null;
after(async () => {
  await cleanup?.();
});

test('workers racing over one queue never run a build twice', { skip, timeout: 240_000 }, async () => {
  const { config } = await import('../src/config.js');
  const { buildEngine } = await import('../src/development/bootstrap.js');
  const { DevService } = await import('../src/development/service.js');
  const { DevWorker } = await import('../src/development/worker.js');
  const { PostgresDevStore } = await import('../src/development/store/postgres.js');
  const { LocalRuntime } = await import('../src/development/runtime/executor.js');
  const { NoFunding } = await import('../src/development/funding.js');
  const { deterministicAstra, deterministicFable } = await import('../src/development/engine/deterministic.js');

  const root = await mkdtemp(path.join(os.tmpdir(), 'rk-dev-workers-'));
  const store = new PostgresDevStore({ url: URL_, schema });
  cleanup = async () => {
    await (store as any).db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await store.close();
    await rm(root, { recursive: true, force: true });
  };
  await store.init();

  const engine = buildEngine(config.development, {
    store,
    runtime: new LocalRuntime({ root }),
    providers: { astra: deterministicAstra(), fable: deterministicFable(), mode: 'deterministic' },
    funding: new NoFunding(),
    artifacts: null,
    production: false,
    report: () => undefined,
  });
  const service = new DevService(engine);

  const ids: string[] = [];
  for (const [i, taskType] of (['website', 'app', 'game', 'website'] as const).entries()) {
    const { task } = await service.create(
      { id: `racer_${i}` },
      { taskType, title: `Race ${i}`, originalRequest: 'A small landing page with a navigation bar, hero section and footer.', maxBudget: 5, acceptAutonomousExecution: true }
    );
    ids.push(task.id);
  }

  const workers = [0, 1].map(
    (n) => new DevWorker({ store, orchestrator: engine.orchestrator, capabilities: ['web', 'game'], capacity: 2, leaseMs: 60_000, pollMs: 50, id: `racer-worker-${n}` })
  );
  await Promise.all(workers.map((w) => w.start()));

  const deadline = Date.now() + 200_000;
  let states: string[] = [];
  while (Date.now() < deadline) {
    states = await Promise.all(ids.map(async (id) => (await store.getTask(id))!.state));
    if (states.every((s) => s === 'completed' || s === 'failed')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await Promise.all(workers.map((w) => w.stop()));

  assert.deepEqual(states, ids.map(() => 'completed'));
  for (const id of ids) {
    const titles = (await store.listEvents(id, { kinds: ['update'] })).map((e) => e.title);
    for (const once of ['Build started', 'Plan ready', 'Code written', 'Tests and build passed', 'Review passed', 'Done']) {
      assert.equal(titles.filter((t) => t === once).length, 1, `${id}: "${once}" happened ${titles.filter((t) => t === once).length} times`);
    }
    assert.equal((await store.getTask(id))!.revision >= 6, true);
  }
});
