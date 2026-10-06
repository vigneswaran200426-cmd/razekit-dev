// The Battle Mode benchmark: the same fixed builds, measured the same way.
//
// Three real builds — a website, an app and a game — go through the actual
// orchestrator, runtime, verification (including the game playtest) and
// packaging, on the deterministic models so the work is identical run to
// run. What changes between runs is the platform: that is what it measures.
// Results are stored, and each run is compared with the one before it.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DevStore } from '../store/types.js';
import { telemetryOf, type BuildTelemetry } from './telemetry.js';

export const BENCHMARK_VERSION = 'bench/1';
const SUITE = [
  { taskType: 'website', title: 'Benchmark site', originalRequest: 'A landing page with a navigation bar, hero section, features and footer.' },
  { taskType: 'app', title: 'Benchmark app', originalRequest: 'A small task list app where I can add, complete and remove tasks.' },
  { taskType: 'game', title: 'Benchmark game', originalRequest: 'An endless runner game with jumping.' },
] as const;

export interface BenchmarkRun {
  id: string;
  version: string;
  at: string;
  by: string;
  builds: { taskType: string; ok: boolean; totalMs: number; phases: BuildTelemetry['phases'] }[];
  totalMs: number;
  ok: boolean;
  /** Against the previous run of the same version: negative is faster. */
  deltaMs: number | null;
  previousId: string | null;
}

export async function runBenchmark(store: DevStore, by: string, now: () => Date = () => new Date()): Promise<BenchmarkRun> {
  const [{ buildEngine }, { DevService }, { DevWorker }, { MemoryDevStore }, { LocalRuntime }, { NoFunding }, det, { config }] = await Promise.all([
    import('../bootstrap.js'),
    import('../service.js'),
    import('../worker.js'),
    import('../store/memory.js'),
    import('../runtime/executor.js'),
    import('../funding.js'),
    import('../engine/deterministic.js'),
    import('../../config.js'),
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'rk-bench-'));
  try {
    const benchStore = new MemoryDevStore();
    const engine = buildEngine(config.development, {
      store: benchStore,
      runtime: new LocalRuntime({ root, memoryMb: config.development.buildMemoryMb }),
      providers: { astra: det.deterministicAstra(), fable: det.deterministicFable(), mode: 'deterministic' },
      funding: new NoFunding(),
      artifacts: null,
      production: false,
      notifier: null,
      github: null,
      report: () => undefined,
    });
    await benchStore.init();
    const service = new DevService(engine);
    const worker = new DevWorker({ store: benchStore, orchestrator: engine.orchestrator, capabilities: ['web', 'game'], capacity: 1, leaseMs: 120_000 });
    const builds: BenchmarkRun['builds'] = [];
    for (const spec of SUITE) {
      const started = Date.now();
      const { task } = await service.create({ id: 'benchmark' }, { ...spec, maxBudget: 5, acceptAutonomousExecution: true });
      for (let i = 0; i < 80 && (await worker.runOnce()); i++);
      const done = (await benchStore.getTask(task.id))!;
      const t = telemetryOf(done, await benchStore.listEvents(done.id, { kinds: ['update'] }), { runtime: 'local', models: 'deterministic' });
      builds.push({ taskType: spec.taskType, ok: done.state === 'completed', totalMs: Date.now() - started, phases: t.phases });
    }
    const previous = (await store.listRecords<BenchmarkRun>('benchmark', { limit: 20 })).map((r) => r.data).find((r) => r.version === BENCHMARK_VERSION && r.ok);
    const totalMs = builds.reduce((s, b) => s + b.totalMs, 0);
    const ok = builds.every((b) => b.ok);
    const run: BenchmarkRun = {
      id: `bench_${now().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${Math.random().toString(16).slice(2, 6)}`,
      version: BENCHMARK_VERSION,
      at: now().toISOString(),
      by,
      builds,
      totalMs,
      ok,
      deltaMs: previous && ok ? totalMs - previous.totalMs : null,
      previousId: previous?.id ?? null,
    };
    await store.putRecord('benchmark', run.id, run);
    return run;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
