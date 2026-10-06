// The RazeKit Development area, end to end over HTTP.
//
// Real router, real control plane, real orchestrator, real worker, real
// workspaces, real processes — driven through the same routes the web app
// calls. Only identity is stubbed (a header stands in for the session cookie)
// and, where a test needs money to move, the model pair is wrapped so its calls
// have a known cost.
//
// What is proven here: the area is off unless deliberately switched on; a
// build needs explicit consent; one account can never see another's build; a
// build runs to COMPLETED only through verification; a hard budget stops the
// build and asks; refinements land in the output; boundary changes wait for
// approval; cancelling stops and settles; operators can pause everything; and
// production refuses every weaker substitute, saying why.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
// Deliberately NOT setting DEV_AREA_ENABLED, so the default is what gets tested.

const { config } = await import('../src/config.js');
const { buildEngine } = await import('../src/development/bootstrap.js');
const { DevService } = await import('../src/development/service.js');
const { createDevelopmentRouter } = await import('../src/development/routes.js');
const { DevWorker } = await import('../src/development/worker.js');
const { MemoryDevStore } = await import('../src/development/store/memory.js');
const { LocalRuntime } = await import('../src/development/runtime/executor.js');
const { NoFunding } = await import('../src/development/funding.js');
const { deterministicAstra, deterministicFable } = await import('../src/development/engine/deterministic.js');
const { DevError, ERR } = await import('../src/development/engine/errors.js');
const { unavailableFable } = await import('../src/development/engine/providers.js');
const { __resetRateLimits } = await import('../src/middleware/rateLimit.js');
import type { ProviderSet, PreparedCall } from '../src/development/engine/providers.js';

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rk-dev-api-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── Harness ──────────────────────────────────────────────────────────────────

const deterministic = (): ProviderSet => ({ astra: deterministicAstra(), fable: deterministicFable(), mode: 'deterministic' });

/** The deterministic pair, but every call reserves `ceiling` and costs `cost`. */
function costed(ceiling: number, cost: number): ProviderSet {
  const base = deterministic();
  const wrap = (p: PreparedCall): PreparedCall => ({ ceilingMinor: ceiling, run: async () => ({ ...(await p.run()), costMinor: cost }) });
  const price = { inputMinorPerMTok: 100, outputMinorPerMTok: 100 };
  return {
    mode: 'deterministic',
    astra: { info: { ...base.astra.info, price }, preparePlan: (r) => wrap(base.astra.preparePlan(r)), prepareReview: (r) => wrap(base.astra.prepareReview(r)) },
    fable: { info: { ...base.fable.info, price }, prepareImplement: (r) => wrap(base.fable.prepareImplement(r)) },
  };
}

async function harness(opts: { providers?: ProviderSet; production?: boolean; clock?: { t: number }; keepWorkspaces?: boolean; github?: any; deliveryRepos?: string[]; notifier?: any } = {}) {
  __resetRateLimits();
  const clock = opts.clock;
  const store = new MemoryDevStore(clock ? { now: () => clock.t } : {});
  const artifacts = new Map<string, Buffer>();
  const cfg = opts.deliveryRepos ? { ...config.development, github: { ...config.development.github, deliveryRepos: opts.deliveryRepos } } : config.development;
  const engine = buildEngine(cfg, {
    github: opts.github ?? null,
    notifier: opts.notifier ?? null,
    store,
    runtime: new LocalRuntime({ root }),
    providers: opts.providers ?? deterministic(),
    funding: new NoFunding(),
    artifacts: {
      put: async (task, bytes) => {
        artifacts.set(`mem:${task.id}`, bytes);
        return `mem:${task.id}`;
      },
      signedUrl: async (uri, ttl) => `https://files.test/${uri}?ttl=${ttl}`,
    },
    production: opts.production ?? false,
    now: clock ? () => new Date(clock.t) : undefined,
    report: () => undefined,
    keepWorkspaces: opts.keepWorkspaces ?? true,
  });
  await store.init();
  const service = new DevService(engine, { now: clock ? () => new Date(clock.t) : undefined });
  const worker = new DevWorker({ store, orchestrator: engine.orchestrator, capabilities: ['web', 'game'], capacity: 1, leaseMs: 60_000 });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.header('x-test-user');
    req.user = id ? { id, role: req.header('x-test-role') || 'user' } : null;
    (req as any).appUser = id ? { id, email: req.header('x-test-email') || `${id}@example.test` } : null;
    next();
  });
  app.use('/api/development', createDevelopmentRouter(async () => service));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/development`;

  async function call(method: string, p: string, { user = 'alice', role, body, headers = {} }: { user?: string | null; role?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-test-user': user } : {}),
        ...(role ? { 'x-test-role': role } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  /** Runs the worker until the queue is empty, one tick at a time. */
  async function drain(max = 60) {
    let n = 0;
    while (n < max && (await worker.runOnce())) n += 1;
    return n;
  }

  return { engine, store, service, worker, call, drain, artifacts, close: () => new Promise((r) => server.close(r)) };
}

const website = {
  taskType: 'website',
  title: 'Beta landing page',
  originalRequest: 'A responsive landing page with a navigation bar, hero section, call to action and footer.',
  maxBudget: 25,
  acceptAutonomousExecution: true,
  acceptanceCriteria: [],
};

// ── The switch ───────────────────────────────────────────────────────────────

test('the area is off unless a deployment deliberately turns it on', async () => {
  assert.equal(config.development.enabled, false);
  const previous = process.env.DEV_AREA_ENABLED;
  for (const value of ['', 'false', '1', 'yes', 'TRUE', 'on']) {
    process.env.DEV_AREA_ENABLED = value;
    const fresh = await import(`../src/config.js?enabled=${encodeURIComponent(value)}`);
    assert.equal(fresh.config.development.enabled, false, `DEV_AREA_ENABLED=${JSON.stringify(value)} must not enable the area`);
  }
  process.env.DEV_AREA_ENABLED = 'true';
  const on = await import('../src/config.js?enabled=true-exact');
  assert.equal(on.config.development.enabled, true);
  if (previous === undefined) delete process.env.DEV_AREA_ENABLED;
  else process.env.DEV_AREA_ENABLED = previous;
});

// ── Consent, identity, tenancy ───────────────────────────────────────────────

test('every route needs a signed-in account', async () => {
  const h = await harness();
  try {
    for (const [m, p] of [['GET', '/status'], ['GET', '/tasks'], ['POST', '/tasks'], ['POST', '/tasks/analyze'], ['GET', '/admin/health']]) {
      assert.equal((await h.call(m, p, { user: null })).status, 401, `${m} ${p}`);
    }
  } finally {
    await h.close();
  }
});

test('pre-flight estimates and routes, and creates nothing', async () => {
  const h = await harness();
  try {
    const r = await h.call('POST', '/tasks/analyze', { body: { taskType: 'website', originalRequest: website.originalRequest } });
    assert.equal(r.status, 200);
    assert.equal(r.body.predictedAgentType, 'niomi');
    assert.ok(r.body.estimatedBudget > 0);
    assert.deepEqual((await h.call('GET', '/tasks')).body, []);
  } finally {
    await h.close();
  }
});

test('a build without explicit consent is refused', async () => {
  const h = await harness();
  try {
    for (const consent of [undefined, false, 'true', 1]) {
      const r = await h.call('POST', '/tasks', { body: { ...website, acceptAutonomousExecution: consent } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'DEV_AUTHORIZATION_REQUIRED');
    }
    assert.deepEqual((await h.call('GET', '/tasks')).body, []);
  } finally {
    await h.close();
  }
});

test('bad input is refused with a reason', async () => {
  const h = await harness();
  try {
    const bad = [
      { ...website, taskType: 'crypto-miner' },
      { ...website, originalRequest: '' },
      { ...website, maxBudget: 0 },
      { ...website, maxBudget: 100000 },
      { ...website, acceptanceCriteria: ['x'.repeat(301)] },
    ];
    for (const body of bad) assert.equal((await h.call('POST', '/tasks', { body })).status, 400, JSON.stringify(body).slice(0, 80));
  } finally {
    await h.close();
  }
});

test("one account can never see or touch another account's build", async () => {
  const h = await harness();
  try {
    const created = await h.call('POST', '/tasks', { body: website });
    assert.equal(created.status, 201);
    const id = created.body.task.id;
    assert.equal(created.body.task.tenantId, 'rk-user-alice');
    assert.equal(created.body.agent.agentType, 'niomi');

    for (const [m, p, body] of [
      ['GET', `/tasks/${id}`],
      ['GET', `/tasks/${id}/dashboard`],
      ['GET', `/tasks/${id}/acceptance`],
      ['GET', `/tasks/${id}/artifact`],
      ['PATCH', `/tasks/${id}`, { title: 'mine now' }],
      ['POST', `/tasks/${id}/commands`, { content: 'hello' }],
      ['POST', `/tasks/${id}/cancel`],
    ] as const) {
      const r = await h.call(m, p, { user: 'mallory', body });
      assert.equal(r.status, 404, `${m} ${p} must read as missing, not forbidden`);
    }
    assert.deepEqual((await h.call('GET', '/tasks', { user: 'mallory' })).body, []);
    assert.equal((await h.call('GET', `/tasks/${id}`)).body.state, 'queued', 'untouched');
  } finally {
    await h.close();
  }
});

test('a double-submitted build is one build', async () => {
  const h = await harness();
  try {
    const headers = { 'idempotency-key': 'start-build-0001' };
    const a = await h.call('POST', '/tasks', { body: website, headers });
    const b = await h.call('POST', '/tasks', { body: website, headers });
    assert.equal(a.body.task.id, b.body.task.id);
    assert.equal((await h.call('GET', '/tasks')).body.length, 1);
  } finally {
    await h.close();
  }
});

// ── Building ─────────────────────────────────────────────────────────────────

test('a website is planned, written, tested, built, reviewed and verified to COMPLETED', async () => {
  const h = await harness();
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    assert.ok((await h.drain()) >= 6, 'one transition per tick');

    const d = (await h.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.status, 'COMPLETED');
    assert.equal(d.progress.percent, 100);
    assert.equal(d.verification.status, 'passed');
    assert.ok(d.verification.checks.some((c: any) => c.check === 'tests' && c.passed));
    assert.ok(d.deliverables.some((x: any) => x.path === 'index.html'));
    assert.ok(d.budget.currentSpend <= d.budget.maxBudget);
    assert.ok(d.chat.length > 0 && d.events.length > 0);
    assert.ok(!JSON.stringify(d).includes('blackboard'), 'machinery stays server-side');

    const acceptance = (await h.call('GET', `/tasks/${id}/acceptance`)).body;
    assert.ok(acceptance.length > 0 && acceptance.every((c: any) => c.status === 'passed'));

    const artifact = await h.call('GET', `/tasks/${id}/artifact`);
    assert.equal(artifact.status, 200);
    assert.match(artifact.body.url, /^https:\/\/files\.test\//);
    assert.ok(h.artifacts.get(`mem:${id}`)!.length === artifact.body.bytes);

    assert.equal((await h.call('POST', `/tasks/${id}/commands`, { body: { content: 'one more thing' } })).status, 409, 'a finished build takes no more changes');
  } finally {
    await h.close();
  }
});

test('a game goes to Konami and ships on the RazeKit game runtime', async () => {
  const h = await harness();
  try {
    const r = await h.call('POST', '/tasks', { body: { ...website, taskType: 'game', title: 'Sky Dash', originalRequest: 'An endless runner where you jump over obstacles and score points.' } });
    assert.equal(r.body.agent.agentType, 'konami');
    await h.drain();
    const d = (await h.call('GET', `/tasks/${r.body.task.id}/dashboard`)).body;
    assert.equal(d.status, 'COMPLETED', JSON.stringify(d.failure ?? d.verification));
    assert.ok(d.verification.checks.some((c: any) => c.check === 'engine' && c.passed));
  } finally {
    await h.close();
  }
});

test('a refinement asked for mid-build lands in what is built', async () => {
  const h = await harness();
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    await h.worker.runOnce(); // queued → planning
    const c = await h.call('POST', `/tasks/${id}/commands`, { body: { content: 'Make the hero dark blue' } });
    assert.equal(c.body.classification, 'refinement');
    assert.equal(c.body.change.status, 'applied');
    await h.drain();
    const task = (await h.store.getTask(id))!;
    assert.equal(task.state, 'completed');
    const css = await h.engine.runtime.workspaces.readText(task.workspaceId, 'dist/styles.css');
    assert.match(css!, /--hero: #0b1f4d/);
  } finally {
    await h.close();
  }
});

test('a refinement that arrives after the code was written is applied before completion', async () => {
  const h = await harness();
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    // Run until the build is being reviewed: the code exists already.
    for (let i = 0; i < 10 && (await h.store.getTask(id))!.state !== 'reviewing'; i++) await h.worker.runOnce();
    await h.call('POST', `/tasks/${id}/commands`, { body: { content: 'Make the footer purple' } });
    await h.drain();
    const task = (await h.store.getTask(id))!;
    assert.equal(task.state, 'completed');
    assert.equal(task.attempts.implement, 2, 'it went back and rewrote the code');
    assert.match((await h.engine.runtime.workspaces.readText(task.workspaceId, 'dist/styles.css'))!, /--footer: #6d28d9/);
  } finally {
    await h.close();
  }
});

test('a boundary change waits for approval; an out-of-scope one cannot be approved', async () => {
  const h = await harness();
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    const stripe = await h.call('POST', `/tasks/${id}/commands`, { body: { content: 'Add Stripe payments' } });
    assert.equal(stripe.body.classification, 'boundary');
    assert.equal(stripe.body.change.status, 'pending');
    let d = (await h.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.pendingDecisions.length, 1);
    assert.equal(d.pendingDecisions[0].origin, 'user');

    const game = await h.call('POST', `/tasks/${id}/commands`, { body: { content: 'Actually turn it into a platformer game' } });
    assert.equal(game.body.classification, 'out_of_scope');
    assert.equal((await h.call('POST', `/tasks/${id}/changes/${game.body.change.id}/approve`, { body: {} })).status, 409);
    assert.equal((await h.call('POST', `/tasks/${id}/changes/${game.body.change.id}/deny`, { body: { reason: 'no' } })).status, 200);

    const ok = await h.call('POST', `/tasks/${id}/changes/${stripe.body.change.id}/deny`, { body: {} });
    assert.equal(ok.body.change.status, 'denied');
    assert.equal((await h.call('POST', `/tasks/${id}/changes/${stripe.body.change.id}/approve`, { body: {} })).status, 409, 'decided once');
    d = (await h.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.pendingDecisions.length, 0);
  } finally {
    await h.close();
  }
});

// ── Money ────────────────────────────────────────────────────────────────────

test('the budget is a hard limit: the build stops and asks, then continues when raised', async () => {
  // Every call reserves 50 and costs 30, against a $1.00 limit: plan (30) and
  // implement (60) fit; review needs 50 with only 40 left.
  const h = await harness({ providers: costed(50, 30) });
  try {
    const id = (await h.call('POST', '/tasks', { body: { ...website, maxBudget: 1 } })).body.task.id;
    await h.drain();
    let d = (await h.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.status, 'DECISION NEEDED');
    assert.equal(d.budget.currentSpend, 0.6);
    assert.ok(d.budget.currentSpend <= d.budget.maxBudget);
    const decision = d.pendingDecisions[0];
    assert.equal(decision.origin, 'build');
    assert.equal(decision.budgetSnapshot.withinBudget, false);

    // Approving cannot silently raise the ceiling.
    assert.equal((await h.call('POST', `/tasks/${id}/changes/${decision.id}/approve`, { body: {} })).status, 400);
    const approved = await h.call('POST', `/tasks/${id}/changes/${decision.id}/approve`, { body: { maxBudget: 2 } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    await h.drain();
    d = (await h.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.status, 'COMPLETED');
    assert.equal(d.budget.maxBudget, 2);
    assert.equal(d.budget.currentSpend, 0.9);
    // Answering the budget question is not a code change: it never reaches
    // the implementer as a refinement.
    const task = (await h.store.getTask(id))!;
    assert.deepEqual(task.blackboard.refinements, []);
    assert.ok(!d.chat.some((m: any) => /cannot apply/.test(m.content)));
  } finally {
    await h.close();
  }
});

test('declining a budget stop ends the build and settles it', async () => {
  const h = await harness({ providers: costed(50, 30) });
  try {
    const id = (await h.call('POST', '/tasks', { body: { ...website, maxBudget: 1 } })).body.task.id;
    await h.drain();
    const decision = (await h.call('GET', `/tasks/${id}/dashboard`)).body.pendingDecisions[0];
    await h.call('POST', `/tasks/${id}/changes/${decision.id}/deny`, { body: {} });
    await h.drain();
    const task = (await h.store.getTask(id))!;
    assert.equal(task.state, 'cancelled');
    assert.equal(task.funding.settlement?.status, 'settled');
    assert.equal(task.nextRunAt, null);
  } finally {
    await h.close();
  }
});

test('cancelling stops the build at the next step and settles it', async () => {
  const h = await harness();
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    await h.worker.runOnce();
    const r = await h.call('POST', `/tasks/${id}/cancel`);
    assert.equal(r.body.status, 'cancelled');
    await h.drain();
    const d = (await h.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.status, 'STOPPED');
    assert.equal((await h.store.getTask(id))!.funding.settlement?.status, 'settled');
    assert.equal((await h.call('POST', `/tasks/${id}/cancel`)).status, 409);
  } finally {
    await h.close();
  }
});

// ── Failures ─────────────────────────────────────────────────────────────────

test('an unconfigured model stops the build with the reason, and is never retried', async () => {
  const h = await harness({ providers: { astra: deterministicAstra(), fable: unavailableFable('FABLE_API_KEY is not set.'), mode: 'unavailable' } });
  try {
    // Not "ready" as a deployment, so creation is refused outright...
    assert.equal((await h.call('POST', '/tasks', { body: website })).status, 503);
  } finally {
    await h.close();
  }

  // ...and a credential rejected mid-build stops that build with the reason.
  const base = deterministic();
  const rejected: ProviderSet = {
    ...base,
    fable: {
      info: base.fable.info,
      prepareImplement: () => ({
        ceilingMinor: 0,
        run: async () => {
          throw new DevError(ERR.PROVIDER_UNAVAILABLE, 'Fable is not available: the configured credential was rejected.', { retryable: false });
        },
      }),
    },
  };
  const h2 = await harness({ providers: rejected });
  try {
    const id = (await h2.call('POST', '/tasks', { body: website })).body.task.id;
    await h2.drain();
    const d = (await h2.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.status, 'BLOCKED');
    assert.match(d.failure.message, /credential was rejected/);
    assert.equal((await h2.store.getTask(id))!.attempts.transient, 0, 'never retried');
  } finally {
    await h2.close();
  }
});

test('a provider hiccup is retried with backoff; the build still completes', async () => {
  const clock = { t: Date.now() };
  const base = deterministic();
  let failures = 1;
  const flaky: ProviderSet = {
    ...base,
    fable: {
      info: base.fable.info,
      prepareImplement: (r) => {
        const p = base.fable.prepareImplement(r);
        return {
          ceilingMinor: p.ceilingMinor,
          run: async () => {
            if (failures-- > 0) throw new DevError(ERR.PROVIDER_FAILED, 'Fable request failed (529: overloaded_error).', { retryable: true });
            return p.run();
          },
        };
      },
    },
  };
  const h = await harness({ providers: flaky, clock });
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    await h.drain();
    let task = (await h.store.getTask(id))!;
    assert.equal(task.state, 'implementing');
    assert.equal(task.attempts.transient, 1);
    assert.equal(await h.worker.runOnce(), false, 'not before the backoff');
    clock.t += 10_000;
    await h.drain();
    task = (await h.store.getTask(id))!;
    assert.equal(task.state, 'completed');
  } finally {
    await h.close();
  }
});

test('a model that keeps answering with something unusable is stopped, not retried forever', async () => {
  const base = deterministic();
  const broken: ProviderSet = {
    ...base,
    fable: {
      info: base.fable.info,
      prepareImplement: () => ({ ceilingMinor: 0, run: async () => ({ raw: { files: [{ path: '../../escape.mjs', content: '' }], steps: [], output: { dir: 'dist', entry: 'index.html' } }, usage: { inputTokens: 0, outputTokens: 0 }, costMinor: 0, model: 'x' }) }),
    },
  };
  const h = await harness({ providers: broken });
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    await h.drain();
    const d = (await h.call('GET', `/tasks/${id}/dashboard`)).body;
    assert.equal(d.status, 'BLOCKED');
    assert.match(d.failure.message, /unusable output/);
    assert.equal((await h.store.getTask(id))!.attempts.invalidOutput, 3);
  } finally {
    await h.close();
  }
});

// ── Operators ────────────────────────────────────────────────────────────────

test('operators can see health and pause all execution; users cannot', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('GET', '/admin/health')).status, 403);
    assert.equal((await h.call('POST', '/admin/execution', { body: { paused: true } })).status, 403);

    const health = await h.call('GET', '/admin/health', { user: 'root', role: 'admin' });
    assert.equal(health.status, 200);
    assert.equal(health.body.readiness.ready, true);
    assert.equal(health.body.runtime.kind, 'local');
    assert.ok(!JSON.stringify(health.body).includes('apiKey'));

    await h.call('POST', '/admin/execution', { user: 'root', role: 'admin', body: { paused: true, reason: 'incident' } });
    await h.call('POST', '/tasks', { body: website });
    assert.equal(await h.worker.runOnce(), false, 'paused workers claim nothing');
    await h.call('POST', '/admin/execution', { user: 'root', role: 'admin', body: { paused: false } });
    assert.equal(await h.worker.runOnce(), true);

    assert.equal((await h.call('POST', '/admin/budget-purchases', { user: 'root', role: 'admin', body: { userId: 'alice', budget: 10, paymentReference: 'UTR-1234' } })).status, 409, 'no ledger in this deployment');
  } finally {
    await h.close();
  }
});

test('production refuses every weaker substitute, and says which', async () => {
  const engine = buildEngine({ ...config.development, databaseUrl: '', store: '', funding: 'none' }, { production: true, artifacts: null, report: () => undefined });
  assert.equal(engine.readiness.ready, false);
  const problems = engine.readiness.problems.join('\n');
  assert.match(problems, /Postgres store/);
  assert.match(problems, /local process runtime/);
  assert.match(problems, /ASTRA_API_KEY and FABLE_API_KEY/);
  assert.match(problems, /DEV_FUNDING=ledger/);
  assert.equal(engine.providers.mode, 'unavailable', 'never the deterministic pair in production');
  // Unset, production funding defaults to the ledger rather than to nothing.
  assert.equal(buildEngine({ ...config.development, funding: '' }, { production: true, artifacts: null }).funding.mode, 'ledger');

  const svc = new DevService(engine);
  await assert.rejects(svc.create({ id: 'alice' }, website), (e: any) => e.httpStatus === 503);
  assert.equal(svc.status({ id: 'alice' }).configured, false);
  assert.ok(!('readiness' in svc.status({ id: 'alice' })), 'users are not told the deployment internals');
  assert.ok('readiness' in svc.status({ id: 'root', role: 'admin' }));
});

test('a settled build leaves nothing on the worker disk once its artifact is stored', async () => {
  const h = await harness({ keepWorkspaces: false });
  try {
    const done = (await h.call('POST', '/tasks', { body: website })).body.task;
    const stopped = (await h.call('POST', '/tasks', { body: website, headers: { 'idempotency-key': 'second-build-01' } })).body.task;
    await h.call('POST', `/tasks/${stopped.id}/cancel`);
    await h.drain();
    const ws = h.engine.runtime.workspaces;
    assert.equal((await h.store.getTask(done.id))!.state, 'completed');
    assert.equal((await ws.scan(done.workspaceId)).files.length, 0, 'completed and stored: workspace removed');
    assert.equal((await ws.scan(stopped.workspaceId)).files.length, 0, 'stopped: workspace removed');
    assert.equal((await h.call('GET', `/tasks/${done.id}/artifact`)).status, 200, 'the artifact is still downloadable');
  } finally {
    await h.close();
  }
});

test('a worker saving at the same moment cannot lose a raised budget or a stop', async () => {
  const { LedgerFunding, recordVerifiedPurchase } = await import('../src/development/funding.js');
  const { makeLedgerSvc, serialUnitOfWork, ledgerBalance } = await import('./helpers/dev.js');

  /** Saves on behalf of a "worker" immediately before the next unleased save. */
  class RacingStore extends MemoryDevStore {
    race = false;
    async saveTask(task: any, opts: { expectedRevision: number; leaseToken?: string }) {
      if (this.race && opts.leaseToken === undefined) {
        this.race = false;
        const current = (await super.getTask(task.id))!;
        await super.saveTask({ ...current, updatedAt: new Date().toISOString() }, { expectedRevision: current.revision });
      }
      return super.saveTask(task, opts);
    }
  }

  const svc = makeLedgerSvc();
  const unitOfWork = serialUnitOfWork(svc);
  const store = new RacingStore();
  const engine = buildEngine(config.development, {
    store,
    runtime: new LocalRuntime({ root }),
    providers: deterministic(),
    funding: new LedgerFunding({ unitOfWork, currency: 'USD' }),
    artifacts: null,
    production: false,
    report: () => undefined,
  });
  const service = new DevService(engine, { unitOfWork });
  await recordVerifiedPurchase(unitOfWork, { userId: 'alice', budgetMinor: 5000, paymentReference: 'UTR-RACE-0001', adminId: 'root', currency: 'USD', platformFeeBps: 1500 });

  const { task } = await service.create({ id: 'alice' }, { ...website, maxBudget: 10 });
  const { change } = await service.command({ id: 'alice' }, task.id, 'Add Stripe payments');

  store.race = true;
  await service.approve({ id: 'alice' }, task.id, change.id, { maxBudget: 20 });
  const raised = (await store.getTask(task.id))!;
  assert.equal(raised.maxBudgetMinor, 2000);
  assert.deepEqual(raised.funding.reservations.map((r) => r.amountMinor), [1000, 1000], 'the raise is recorded despite the race');
  assert.equal(ledgerBalance(svc, 'DEV_BUDGET_RESERVED', 'alice'), 2000);

  store.race = true;
  const stopped = await service.cancel({ id: 'alice' }, task.id);
  assert.equal(stopped.status, 'cancelled', 'the stop is applied to the latest version, not refused');
});

test('answering a budget stop is never handed to the implementer as a change', async () => {
  // Plan reserves 70 and costs 60 against a $1.00 limit; implement then needs
  // 70 with 40 left, so the build stops before any code is written.
  const h = await harness({ providers: costed(70, 60) });
  try {
    const id = (await h.call('POST', '/tasks', { body: { ...website, maxBudget: 1 } })).body.task.id;
    await h.drain();
    let task = (await h.store.getTask(id))!;
    assert.equal(task.state, 'waiting_user');
    assert.equal(task.resumeState, 'implementing');
    const decision = (await h.call('GET', `/tasks/${id}/dashboard`)).body.pendingDecisions[0];
    await h.call('POST', `/tasks/${id}/changes/${decision.id}/approve`, { body: { maxBudget: 3 } });
    await h.drain();
    task = (await h.store.getTask(id))!;
    assert.equal(task.state, 'completed');
    assert.deepEqual(task.blackboard.refinements, [], 'the decision is not a refinement');
    const chat = (await h.call('GET', `/tasks/${id}/dashboard`)).body.chat;
    assert.ok(!chat.some((m: any) => /cannot apply/.test(m.content)), 'the implementer was not asked to apply it');
  } finally {
    await h.close();
  }
});

// ── Delivery to GitHub ───────────────────────────────────────────────────────

test('a verified build is delivered once, as a draft PR, only by its owner, only to an allowed repository', async () => {
  const { GitHubApp } = await import('../src/development/delivery/github.js');
  const { APP_ID, PEM, fakeGitHub } = await import('./helpers/github.js');
  const gh = fakeGitHub();
  const h = await harness({ github: new GitHubApp({ appId: APP_ID, privateKey: PEM }, { fetch: gh.fetch, now: gh.now }), deliveryRepos: ['acme/site'] });
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    const early = await h.call('POST', `/tasks/${id}/deliver`, { body: { repository: 'acme/site' } });
    assert.equal(early.status, 409, 'not before it is verified');

    await h.drain();
    assert.equal((await h.call('GET', `/tasks/${id}`)).body.state, 'completed');
    assert.equal((await h.call('POST', `/tasks/${id}/deliver`, { user: 'mallory', body: { repository: 'acme/site' } })).status, 404, 'only the owner');
    assert.equal((await h.call('POST', `/tasks/${id}/deliver`, { body: { repository: 'acme/other' } })).status, 400, 'only an allowed repository');
    assert.equal(gh.prs.length, 0);

    const first = await h.call('POST', `/tasks/${id}/deliver`, { body: { repository: 'acme/site' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.pullRequest.draft, true);
    assert.equal(first.body.branch, `razekit-dev/${id}`);
    assert.equal(first.body.replayed, false);
    const paths = gh.trees[0].tree.map((e: any) => e.path);
    assert.ok(paths.every((p: string) => p.startsWith(`razekit-dev/${id}/`)), 'everything under the build directory');
    assert.ok(paths.includes(`razekit-dev/${id}/index.html`));
    assert.equal(gh.refs.get('acme/site:main'), 'base0', 'the base branch is untouched');

    const again = await h.call('POST', `/tasks/${id}/deliver`, { body: { repository: 'acme/site' } });
    assert.equal(again.body.replayed, true);
    assert.equal(gh.prs.length, 1, 'one pull request, however many times it is asked');
    const detail = (await h.call('GET', `/tasks/${id}`)).body;
    assert.equal(detail.delivery.pullRequest.url, first.body.pullRequest.url);
    const updates = (await h.store.listEvents(id, { kinds: ['update'] })).filter((e) => e.title === 'Delivered to GitHub');
    assert.equal(updates.length, 1);
  } finally {
    await h.close();
  }
});

test('without a configured GitHub App, delivery says so', async () => {
  const h = await harness({ deliveryRepos: ['acme/site'] });
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    await h.drain();
    const r = await h.call('POST', `/tasks/${id}/deliver`, { body: { repository: 'acme/site' } });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'DEV_NOT_CONFIGURED');
  } finally {
    await h.close();
  }
});

// ── Public visibility ────────────────────────────────────────────────────────

test('the public DEV entry is an administrator decision, readable by anyone, changeable by admins only', async () => {
  const h = await harness();
  try {
    const anon = await h.call('GET', '/visibility', { user: null });
    assert.equal(anon.status, 200);
    assert.deepEqual(anon.body, { visible: false }, 'hidden until an administrator shows it; nothing else is disclosed');

    const user = (await h.call('GET', '/status')).body;
    assert.equal(user.visible, false);
    assert.equal(user.showEntry, false, 'hidden from users');
    assert.equal((await h.call('GET', '/status', { user: 'root', role: 'admin' })).body.showEntry, true, 'administrators always see it');

    assert.equal((await h.call('POST', '/admin/visibility', { body: { visible: true } })).status, 403, 'users cannot change it');
    assert.equal((await h.call('POST', '/admin/visibility', { user: null, body: { visible: true } })).status, 401);
    assert.equal((await h.call('POST', '/admin/visibility', { user: 'root', role: 'admin', body: { visible: 'yes' } })).status, 400);

    const shown = await h.call('POST', '/admin/visibility', { user: 'root', role: 'admin', body: { visible: true, reason: 'launch' } });
    assert.equal(shown.status, 200);
    assert.deepEqual((await h.call('GET', '/visibility', { user: null })).body, { visible: true });
    assert.equal((await h.call('GET', '/status')).body.showEntry, true);

    // Hiding is not deleting: builds keep working.
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    await h.call('POST', '/admin/visibility', { user: 'root', role: 'admin', body: { visible: false } });
    await h.drain();
    assert.equal((await h.call('GET', `/tasks/${id}`)).body.state, 'completed');
    assert.equal((await h.call('GET', '/visibility', { user: null })).body.visible, false);
    const log = await h.store.getControl<any[]>('public-visibility-log');
    assert.deepEqual(log!.map((c) => [c.visible, c.changedBy]), [[false, 'root'], [true, 'root']], 'every change is recorded with who made it');
    assert.equal((await h.call('GET', '/admin/health', { user: 'root', role: 'admin' })).body.visibility.visible, false);
  } finally {
    await h.close();
  }
});

// ── Email notifications ──────────────────────────────────────────────────────

test('the owner is emailed once when a build finishes, never for steps, and a failed send never fails the build', async () => {
  const { createEmailNotifier } = await import('../src/development/notify.js');
  const sent: any[] = [];
  let store: any;
  const notifier = {
    notify: (task: any, kind: any) =>
      createEmailNotifier({ store, send: async (m) => void sent.push(m), webBaseUrl: 'https://razekit.test' }).notify(task, kind),
  };
  const h = await harness({ notifier });
  store = h.store;
  try {
    const id = (await h.call('POST', '/tasks', { body: website })).body.task.id;
    await h.drain();
    assert.equal((await h.call('GET', `/tasks/${id}`)).body.state, 'completed');
    assert.equal(sent.length, 1, JSON.stringify(sent.map((m) => m.subject)));
    assert.equal(sent[0].to, 'alice@example.test', 'the address comes from the session');
    assert.match(sent[0].subject, /is ready/);
    assert.ok(sent[0].body.includes(`https://razekit.test/development/${id}`));

    // The same moment reached again (a retry, a second worker) sends nothing.
    const task = await h.store.getTask(id);
    await notifier.notify(task, 'completed');
    assert.equal(sent.length, 1);
  } finally {
    await h.close();
  }

  const broken = { notify: (task: any, kind: any) => createEmailNotifier({ store: h2.store, send: async () => { throw new Error('smtp down'); }, webBaseUrl: 'x' }).notify(task, kind) };
  const h2: any = await harness({ notifier: broken });
  try {
    const id = (await h2.call('POST', '/tasks', { body: website })).body.task.id;
    await h2.drain();
    assert.equal((await h2.call('GET', `/tasks/${id}`)).body.state, 'completed', 'email is secondary');
  } finally {
    await h2.close();
  }
});

test('a decision emails the owner once per decision', async () => {
  const { createEmailNotifier } = await import('../src/development/notify.js');
  const { MemoryDevStore } = await import('../src/development/store/memory.js');
  const store = new MemoryDevStore();
  const sent: any[] = [];
  const n = createEmailNotifier({ store, send: async (m) => void sent.push(m), webBaseUrl: 'https://razekit.test' });
  const base: any = { id: 'dtk_x', title: 'Shop', notifyEmail: 'owner@example.test', revision: 3, state: 'waiting_user', decision: { kind: 'budget', message: 'Budget limit reached.', changeId: 'chg_1' } };
  await n.notify(base, 'decision');
  await n.notify(base, 'decision');
  await n.notify({ ...base, decision: { ...base.decision, changeId: 'chg_2' } }, 'decision');
  await n.notify({ ...base, notifyEmail: null, id: 'dtk_y' }, 'decision');
  assert.deepEqual(sent.map((m) => m.subject), ['RazeKit DEV: "Shop" needs your decision', 'RazeKit DEV: "Shop" needs your decision']);
  assert.ok(sent[0].body.includes('Budget limit reached.'));
});

// ── Konami ───────────────────────────────────────────────────────────────────

test('a game build is played headlessly before it completes, and an engine that cannot build is refused before payment', async () => {
  const h = await harness();
  try {
    const engines = (await h.call('GET', '/engines')).body.engines;
    assert.equal(engines.find((e: any) => e.id === 'razekit').buildable, true);
    const refused = await h.call('POST', '/tasks', { body: { ...website, taskType: 'game', title: 'Runner', originalRequest: 'An endless runner game with jumping.', engine: 'unreal' } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Unreal Engine cannot build games on this deployment yet/);
    assert.equal((await h.store.listTasks('rk-user-alice', { limit: 10 })).length, 0, 'nothing was created');

    const id = (await h.call('POST', '/tasks', { body: { ...website, taskType: 'game', title: 'Runner', originalRequest: 'An endless runner game with jumping.', engine: 'razekit' } })).body.task.id;
    await h.drain();
    const task = await h.store.getTask(id);
    assert.equal(task!.state, 'completed');
    const played = task!.verification.checks.find((c: any) => c.check === 'playtest');
    assert.ok(played, 'the verification report includes the playtest');
    assert.equal(played.passed, true, played.evidence);
    assert.match(played.evidence, /Played 3600 steps headlessly: no crash, replay identical/);
  } finally {
    await h.close();
  }
});

// ── Platform administration ─────────────────────────────────────────────────

test('Battle Mode and the Dev Department are administrators only', async () => {
  const h = await harness();
  try {
    for (const [method, p] of [['GET', '/admin/battle'], ['POST', '/admin/battle/settings'], ['POST', '/admin/battle/benchmark'], ['GET', '/admin/incidents'], ['POST', '/admin/incidents'], ['POST', '/admin/incidents/action']] as const) {
      const body = method === 'GET' ? undefined : {};
      assert.equal((await h.call(method, p, { body })).status, 403, `${method} ${p}`);
      assert.equal((await h.call(method, p, { user: null, body })).status, 401, `${method} ${p} anonymous`);
    }
    const admin = { user: 'root', role: 'admin' };
    const overview = (await h.call('GET', '/admin/battle', admin)).body;
    assert.equal(overview.settings.mode, 'off', 'off until turned on');
    const on = await h.call('POST', '/admin/battle/settings', { ...admin, body: { mode: 'analyze', monthlyBudget: 20 } });
    assert.equal(on.status, 200);
    assert.equal(on.body.monthlyBudgetMinor, 2000);
    assert.equal((await h.call('POST', '/admin/battle/settings', { ...admin, body: { mode: 'unlimited' } })).status, 400);

    const filed = await h.call('POST', '/admin/incidents', { ...admin, body: { title: 'Queue stuck after deploy', detail: 'runnable count grew for 20 minutes' } });
    assert.equal(filed.status, 201);
    const list = (await h.call('GET', '/admin/incidents', admin)).body.incidents;
    assert.equal(list[0].title, 'Queue stuck after deploy');
    const acted = await h.call('POST', '/admin/incidents/action', { ...admin, body: { fingerprint: list[0].fingerprint, action: 'acknowledge' } });
    assert.equal(acted.body.status, 'triaged');
  } finally {
    await h.close();
  }
});
