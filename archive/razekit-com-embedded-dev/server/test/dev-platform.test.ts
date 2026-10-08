// Battle Mode and the Dev Department: RazeKit DEV learning from its own builds.
//
// Real builds leave the telemetry; detection runs on it; battles are bounded
// by the platform budget and never call a model that is not the real one;
// incidents are fingerprinted, counted, and reopened as regressions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const { config } = await import('../src/config.js');
const { buildEngine } = await import('../src/development/bootstrap.js');
const { DevService } = await import('../src/development/service.js');
const { DevWorker } = await import('../src/development/worker.js');
const { MemoryDevStore } = await import('../src/development/store/memory.js');
const { LocalRuntime } = await import('../src/development/runtime/executor.js');
const { NoFunding } = await import('../src/development/funding.js');
const { deterministicAstra, deterministicFable } = await import('../src/development/engine/deterministic.js');
const { BattleController, baselines, detect } = await import('../src/development/platform/battle.js');
const { DevDepartment } = await import('../src/development/platform/incidents.js');
const { runBenchmark } = await import('../src/development/platform/benchmark.js');

const root = await mkdtemp(path.join(os.tmpdir(), 'rk-platform-'));
after(() => rm(root, { recursive: true, force: true }));

async function engineWith(providers: any = { astra: deterministicAstra(), fable: deterministicFable(), mode: 'deterministic' }) {
  const store = new MemoryDevStore();
  const engine = buildEngine(config.development, {
    store, runtime: new LocalRuntime({ root }), providers, funding: new NoFunding(), artifacts: null,
    production: false, notifier: null, github: null, report: () => undefined,
  });
  await store.init();
  const service = new DevService(engine);
  const worker = new DevWorker({ store, orchestrator: engine.orchestrator, capabilities: ['web', 'game'], capacity: 1, leaseMs: 60_000 });
  const drain = async () => { for (let i = 0; i < 80 && (await worker.runOnce()); i++); };
  return { store, engine, service, drain };
}

const site = { taskType: 'website', title: 'Site', originalRequest: 'A landing page with a navigation bar, hero section and footer.', maxBudget: 5, acceptAutonomousExecution: true };

test('every settled build leaves telemetry once: timings, retries, outcome — no customer content', async () => {
  const h = await engineWith();
  const a = (await h.service.create({ id: 'u1' }, site)).task.id;
  const b = (await h.service.create({ id: 'u2' }, { ...site, taskType: 'game', title: 'G', originalRequest: 'An endless runner game.' })).task.id;
  await h.drain();
  const recs = await h.store.listRecords<any>('telemetry');
  assert.deepEqual(recs.map((r) => r.key).sort(), [a, b].sort());
  const t = recs.find((r) => r.key === a)!.data;
  assert.equal(t.outcome, 'completed');
  for (const p of ['plan', 'implement', 'execute', 'review', 'verify']) assert.equal(typeof t.phases[p], 'number', p);
  assert.ok(!JSON.stringify(recs).includes('landing page'), 'the request text is not kept');
  await h.drain();
  assert.equal((await h.store.listRecords('telemetry')).length, 2, 'once per build');
});

const tele = (over: any = {}) => ({
  taskId: `t${Math.random()}`, taskType: 'website', agentType: 'niomi', outcome: 'completed', failureCode: null, runtime: 'local', models: 'real',
  phases: { plan: 1000, implement: 2000, execute: 1000, review: 500, verify: 9000 }, reworkMs: 0, totalMs: 13500,
  attempts: { implement: 1, review: 1, verify: 1 }, spentMinor: 100, maxBudgetMinor: 1000, finishedAt: '2026-09-24T00:00:00.000Z', ...over,
});

test('detection needs enough samples, and finds the phase that dominates and the failure that repeats', () => {
  assert.deepEqual(detect(baselines([tele(), tele(), tele()])), [], 'three builds are not evidence');
  const found = detect(baselines([...Array.from({ length: 6 }, () => tele()), ...Array.from({ length: 3 }, () => tele({ outcome: 'failed', failureCode: 'DEV_RUNTIME_UNAVAILABLE' }))]));
  const kinds = found.map((c) => c.fingerprint);
  assert.ok(kinds.includes('SLOW_PHASE:website:verify'), kinds.join(','));
  assert.ok(kinds.includes('REPEATED_FAILURE:website:DEV_RUNTIME_UNAVAILABLE'), kinds.join(','));
  const slow = found.find((c) => c.kind === 'SLOW_PHASE')!;
  assert.equal(slow.evidence.medianMs, 9000);
});

function fakeRealAstra(opts: { ceiling?: number; cost?: number; raw?: any; onRun?: () => void } = {}) {
  const analysis = { decision: 'IMPROVE', problem: 'verify dominates', rootCause: 'tests re-run serially', evidence: ['median 9s'], proposedChange: 'cache the unchanged test results', expectedGain: '40% faster verify', risk: 'low', acceptanceCriteria: ['same checks pass'], benchmark: 'bench/1 website', rollbackPlan: 'revert the PR' };
  return {
    info: { role: 'astra', vendor: 'openai', mode: 'real', model: 'gpt-5.6-sol', available: true, price: { inputMinorPerMTok: 1, outputMinorPerMTok: 1 } },
    preparePlan: () => { throw new Error('unused'); },
    prepareReview: () => { throw new Error('unused'); },
    prepareAnalysis: () => ({ ceilingMinor: opts.ceiling ?? 20, run: async () => { opts.onRun?.(); return { raw: opts.raw ?? analysis, usage: { inputTokens: 1, outputTokens: 1 }, costMinor: opts.cost ?? 7, model: 'gpt-5.6-sol' }; } }),
  } as any;
}

async function seeded(astra: any) {
  const store = new MemoryDevStore();
  for (let i = 0; i < 6; i++) await store.putRecord('telemetry', `t${i}`, tele());
  let clock = Date.parse('2026-09-24T10:00:00Z');
  const battle = new BattleController({ store, astra: () => astra, now: () => new Date(clock) });
  return { store, battle, advance: (ms: number) => (clock += ms) };
}

test('Battle Mode is off until an administrator turns it on, and observe never fights', async () => {
  const s = await seeded(fakeRealAstra());
  assert.deepEqual(await s.battle.tick(), { ran: false });
  await s.battle.setSettings('root', { mode: 'observe' });
  assert.equal((await s.battle.tick()).battle, undefined);
  assert.equal((await s.battle.battles()).length, 0);
});

test('a battle with the real Astra produces a decision record, spends the platform budget, and stops where the platform stops', async () => {
  const s = await seeded(fakeRealAstra());
  await s.battle.setSettings('root', { mode: 'analyze' });
  const { battle } = await s.battle.tick();
  assert.equal(battle!.status, 'challenged');
  assert.equal(battle!.analysis!.proposedChange, 'cache the unchanged test results');
  assert.equal(battle!.spentMinor, 7);
  assert.deepEqual(battle!.stages.map((x) => `${x.stage}:${x.status}`), ['OBSERVE:done', 'BASELINE:done', 'ASTRA_CHALLENGE:done', 'FABLE_IMPLEMENT:blocked']);
  assert.equal((await s.battle.tick()).ran, false, 'one pass per minute, fleet-wide');
  s.advance(61_000);
  assert.equal((await s.battle.tick()).battle, undefined, 'cooldown between battles');

  await assert.rejects(s.battle.decide('root', battle!.id, 'promote', 'x'), /A challenged battle cannot be promoted/);
  await s.battle.decide('root', battle!.id, 'accept', 'worth doing');
  await assert.rejects(s.battle.decide('root', battle!.id, 'promote', 'shipped'), /merged pull request/);
  const promoted = await s.battle.decide('root', battle!.id, 'promote', 'shipped', 'https://github.com/acme/razekit/pull/12');
  assert.equal(promoted.status, 'promoted');
  assert.equal((await s.battle.decide('root', battle!.id, 'rollback', 'p95 regressed')).status, 'rolled_back');
});

test('no stand-in reasoning: without the real Astra a battle is blocked, and it never exceeds the platform budget', async () => {
  const det = await seeded(deterministicAstra());
  await det.battle.setSettings('root', { mode: 'analyze' });
  const blocked = (await det.battle.tick()).battle!;
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blockedReason!, /needs the real Astra model/);

  let ran = 0;
  const poor = await seeded(fakeRealAstra({ ceiling: 500, onRun: () => ran++ }));
  await poor.battle.setSettings('root', { mode: 'analyze', perBattleBudgetMinor: 100 });
  const b = (await poor.battle.tick()).battle!;
  assert.equal(b.status, 'blocked');
  assert.match(b.blockedReason!, /can cost up to 500/);
  assert.equal(ran, 0, 'the call was not made');

  const junk = await seeded(fakeRealAstra({ raw: { decision: 'SHIP_IT' }, cost: 4 }));
  await junk.battle.setSettings('root', { mode: 'analyze' });
  const j = (await junk.battle.tick()).battle!;
  assert.equal(j.status, 'blocked');
  assert.equal(j.spentMinor, 4, 'an unusable answer is still paid for, and counted');
});

test('the Dev Department fingerprints incidents, escalates by frequency, and reopens a resolved one as a regression', async () => {
  const store = new MemoryDevStore();
  const dept = new DevDepartment({ store, astra: () => deterministicAstra(), secrets: ['sk-live-secret-value-1234'], platformBudgetLeft: async () => 1000 });
  const a = await dept.intake({ source: 'build-failure', code: 'DEV_RUNTIME_UNAVAILABLE', message: 'Fargate task dtk_abc123 stopped (exit 137) key sk-live-secret-value-1234', taskId: 'dtk_abc123' });
  const b = await dept.intake({ source: 'build-failure', code: 'DEV_RUNTIME_UNAVAILABLE', message: 'Fargate task dtk_def456 stopped (exit 139) key sk-live-secret-value-1234', taskId: 'dtk_def456' });
  assert.equal(a.fingerprint, b.fingerprint, 'the same fault, whatever the ids and numbers');
  assert.equal(b.count, 2);
  assert.equal(b.severity, 'high');
  assert.ok(!JSON.stringify(b).includes('sk-live-secret-value-1234'), 'secrets are redacted before anything is kept');

  await assert.rejects(dept.act('root', b.fingerprint, 'propose_fix', 'x', 'not a url'), /pull request/);
  await dept.act('root', b.fingerprint, 'propose_fix', 'retry the image pull', 'https://github.com/acme/razekit/pull/7');
  await dept.act('root', b.fingerprint, 'resolve', 'deployed');
  const re = await dept.intake({ source: 'build-failure', code: 'DEV_RUNTIME_UNAVAILABLE', message: 'Fargate task dtk_q1 stopped (exit 2) key sk-live-secret-value-1234', taskId: 'dtk_q1' });
  assert.equal(re.status, 'regressed');
  assert.equal(re.regressions, 1);
  assert.deepEqual(re.history.map((h) => h.action), ['opened', 'propose_fix', 'resolve', 'regressed']);
  await assert.rejects(dept.analyse('root', re.fingerprint), /needs the real Astra model/);
  assert.equal((await dept.list())[0].status, 'regressed', 'regressions sort first');
});

test('a build that fails for a platform reason becomes an incident on its own; a customer-caused one does not', async () => {
  const { DevError, ERR } = await import('../src/development/engine/errors.js');
  const fable = deterministicFable();
  const broken = { ...fable, prepareImplement: (r: any) => ({ ...fable.prepareImplement(r), run: async () => { throw new DevError(ERR.PROVIDER_FAILED, 'Fable returned HTTP 500 for run 8812.', { retryable: false }); } }) };
  const h = await engineWith({ astra: deterministicAstra(), fable: broken, mode: 'deterministic' });
  const id = (await h.service.create({ id: 'u1' }, site)).task.id;
  await h.drain();
  assert.equal((await h.store.getTask(id))!.state, 'failed');
  const incidents = await h.engine.devDepartment.list();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].code, 'DEV_PROVIDER_FAILED');
  assert.equal(incidents[0].samples[0].taskId, id);
  assert.equal((await h.store.listRecords('telemetry')).length, 1, 'the failed build still teaches');
});

test('the benchmark runs real builds and compares each run with the last', async () => {
  const store = new MemoryDevStore();
  const first = await runBenchmark(store, 'root');
  assert.equal(first.ok, true, JSON.stringify(first.builds));
  assert.deepEqual(first.builds.map((b) => b.taskType), ['website', 'app', 'game']);
  assert.equal(first.deltaMs, null);
  const second = await runBenchmark(store, 'root');
  assert.equal(second.previousId, first.id);
  assert.equal(typeof second.deltaMs, 'number');
});
