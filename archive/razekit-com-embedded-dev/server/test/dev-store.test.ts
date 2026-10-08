// The DEV store contract, run against every implementation.
//
// Memory always runs. Postgres runs when DEV_TEST_DATABASE_URL points at a
// database it may create a throwaway schema in; the schema is dropped
// afterwards. CI has no database, so there Postgres is reported as skipped
// rather than silently passing.
//
// The tests that matter most are about money and concurrency: two workers can
// never hold the same build, a stale worker cannot overwrite a newer result, a
// state save cannot move money, and nothing — not the governor, not a bug in it
// — can record a build spending past its ceiling.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { MemoryDevStore } from '../src/development/store/memory.js';
import { PostgresDevStore } from '../src/development/store/postgres.js';
import type { DevStore } from '../src/development/store/types.js';
import { DevError } from '../src/development/engine/errors.js';
import { transition } from '../src/development/engine/states.js';
import { TASK_STATE as S, type DevChange } from '../src/development/engine/types.js';
import { makeTask } from './helpers/dev.js';

const PG_URL = process.env.DEV_TEST_DATABASE_URL || '';
const isCode = (code: string) => (e: unknown) => e instanceof DevError && e.code === code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Factory = { name: string; make: () => Promise<DevStore>; cleanup?: () => Promise<void>; skip?: string | false };

const pgSchema = `dev_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
let pgStore: PostgresDevStore | null = null;

const factories: Factory[] = [
  { name: 'memory', make: async () => new MemoryDevStore() },
  {
    name: 'postgres',
    skip: PG_URL ? false : 'DEV_TEST_DATABASE_URL is not set',
    make: async () => {
      if (!pgStore) {
        pgStore = new PostgresDevStore({ url: PG_URL, schema: pgSchema });
        await pgStore.init();
      }
      return pgStore;
    },
    cleanup: async () => {
      if (!pgStore) return;
      await (pgStore as any).db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE`);
      await pgStore.close();
    },
  },
];

function change(taskId: string, tenantId: string, over: Partial<DevChange> = {}): DevChange {
  return {
    id: `chg_${randomUUID().slice(0, 8)}`,
    taskId,
    tenantId,
    content: 'Make the hero dark blue',
    classification: 'refinement',
    status: 'applied',
    reason: 'In scope',
    budgetSnapshot: { projectedSpend: 1, projectedSpendMinor: 100, remainingMinor: 2000, withinBudget: true },
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...over,
  };
}

for (const f of factories) {
  describe(`DEV store: ${f.name}`, { skip: f.skip }, () => {
    let store: DevStore;
    before(async () => {
      store = await f.make();
      await store.init();
    });
    after(async () => {
      await f.cleanup?.();
    });

    test('initialises idempotently and reports healthy', async () => {
      await store.init();
      assert.equal((await store.health()).ok, true);
    });

    test('a task round-trips exactly', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      const { task: saved, created } = await store.insertTask(task);
      assert.equal(created, true);
      assert.deepEqual(await store.getTask(task.id), saved);
      assert.deepEqual(saved, task);
    });

    test("another tenant's build reads as missing", async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      await store.insertTask(task);
      assert.equal(await store.getTask(task.id, { tenantId: 'rk-user-someone-else' }), null);
      assert.ok(await store.getTask(task.id, { tenantId: task.tenantId }));
      assert.deepEqual(await store.listTasks('rk-user-someone-else'), []);
    });

    test('a double-submitted build is one build', async () => {
      const userId = `u_${randomUUID()}`;
      const a = makeTask({ userId });
      const b = makeTask({ userId });
      const first = await store.insertTask(a, { creationKey: 'click-1' });
      const second = await store.insertTask(b, { creationKey: 'click-1' });
      assert.equal(second.created, false);
      assert.equal(second.task.id, first.task.id);
      assert.equal((await store.listTasks(a.tenantId)).length, 1);
    });

    test('saves are compare-and-set on revision', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      await store.insertTask(task);
      const moved = await store.saveTask(transition(task, S.PLANNING), { expectedRevision: 0 });
      assert.equal(moved.revision, 1);
      await assert.rejects(store.saveTask(transition(task, S.CANCELLED), { expectedRevision: 0 }), isCode('DEV_CONFLICT'));
      assert.equal((await store.getTask(task.id))!.state, S.PLANNING);
    });

    test('a state save can never move money', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}`, maxBudgetMinor: 1000 });
      await store.insertTask(task);
      await store.reserveSpend({ taskId: task.id, reservationId: `r_${randomUUID()}`, kind: 'model', provider: 'x', operation: 'plan', amountMinor: 300 });
      const forged = { ...transition(task, S.PLANNING), spentMinor: 0, reservedMinor: 0, maxBudgetMinor: 999_999 };
      const saved = await store.saveTask(forged, { expectedRevision: 0 });
      assert.equal(saved.reservedMinor, 300);
      assert.equal(saved.maxBudgetMinor, 1000);
    });

    test('two workers never hold the same build', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      await store.insertTask(task);
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.claimTask(`w${i}`, { leaseMs: 30_000 }))
      );
      const mine = claims.filter((c) => c?.task.id === task.id);
      assert.equal(mine.length, 1, 'exactly one worker gets the build');
      for (const c of claims) if (c) await store.releaseLease(c.task.id, c.leaseToken);
    });

    test('a stale worker cannot write over the one that recovered the build', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      await store.insertTask(task);
      let a = await store.claimTask('worker-a', { leaseMs: 50, agentTypes: ['niomi'] });
      while (a && a.task.id !== task.id) {
        await store.releaseLease(a.task.id, a.leaseToken, { retryAt: new Date(Date.now() + 60_000).toISOString() });
        a = await store.claimTask('worker-a', { leaseMs: 50, agentTypes: ['niomi'] });
      }
      assert.ok(a, 'worker a claims');
      await sleep(120); // a stalls past its lease
      const b = await store.claimTask('worker-b', { leaseMs: 30_000 });
      assert.equal(b?.task.id, task.id, 'the expired build is recovered by b');

      await assert.rejects(
        store.saveTask(transition(a!.task, S.PLANNING), { expectedRevision: 0, leaseToken: a!.leaseToken }),
        isCode('DEV_LEASE_LOST')
      );
      const saved = await store.saveTask(transition(b!.task, S.PLANNING), { expectedRevision: 0, leaseToken: b!.leaseToken });
      assert.equal(saved.revision, 1);
      await store.releaseLease(task.id, b!.leaseToken);
    });

    test('waiting and finished builds are never claimed', async () => {
      const waiting = transition(makeTask({ userId: `u_${randomUUID()}`, state: S.EXECUTING }), S.WAITING_USER, {
        decision: { kind: 'budget', message: 'x' },
      });
      await store.insertTask(waiting);
      const unfunded = makeTask({ userId: `u_${randomUUID()}`, fundingMode: 'ledger' });
      await store.insertTask(unfunded);
      const claimed: string[] = [];
      for (let c = await store.claimTask('w', { leaseMs: 30_000 }); c; c = await store.claimTask('w', { leaseMs: 30_000 })) {
        claimed.push(c.task.id);
      }
      assert.ok(!claimed.includes(waiting.id));
      assert.ok(!claimed.includes(unfunded.id));
      for (const id of claimed) {
        const t = await store.getTask(id);
        // Park everything claimed here so later tests start from a quiet queue.
        await store.saveTask({ ...t!, nextRunAt: null }, { expectedRevision: t!.revision });
      }
    });

    test('backoff postpones the next run', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      await store.insertTask(task);
      const c = await store.claimTask('w', { leaseMs: 30_000 });
      assert.equal(c?.task.id, task.id);
      await store.releaseLease(task.id, c!.leaseToken, { retryAt: new Date(Date.now() + 60_000).toISOString() });
      assert.equal(await store.claimTask('w', { leaseMs: 30_000 }), null, 'not before the retry time');
      const t = await store.getTask(task.id);
      await store.saveTask({ ...t!, nextRunAt: null }, { expectedRevision: t!.revision });
    });

    test('reservations enforce the ceiling and replay idempotently', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}`, maxBudgetMinor: 1000 });
      await store.insertTask(task);
      const r1 = await store.reserveSpend({ taskId: task.id, reservationId: `${task.id}:a`, kind: 'model', provider: 'fable', operation: 'implement', amountMinor: 700 });
      assert.equal(r1.ok, true);
      const replay = await store.reserveSpend({ taskId: task.id, reservationId: `${task.id}:a`, kind: 'model', provider: 'fable', operation: 'implement', amountMinor: 700 });
      assert.ok(replay.ok && replay.replayed, 'the same reservation id reserves once');
      const over = await store.reserveSpend({ taskId: task.id, reservationId: `${task.id}:b`, kind: 'model', provider: 'astra', operation: 'review', amountMinor: 301 });
      assert.deepEqual(over, { ok: false, availableMinor: 300 });
      const t = await store.getTask(task.id);
      assert.equal(t!.reservedMinor, 700);
    });

    test('concurrent reservations cannot oversubscribe one budget', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}`, maxBudgetMinor: 1000 });
      await store.insertTask(task);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.reserveSpend({ taskId: task.id, reservationId: `${task.id}:c${i}`, kind: 'model', provider: 'fable', operation: 'implement', amountMinor: 300 })
        )
      );
      assert.equal(results.filter((r) => r.ok).length, 3, 'only three reservations of 300 fit in 1000');
      assert.equal((await store.getTask(task.id))!.reservedMinor, 900);
    });

    test('capture charges what was used, returns the rest, and never charges an overrun', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}`, maxBudgetMinor: 1000 });
      await store.insertTask(task);
      await store.reserveSpend({ taskId: task.id, reservationId: `${task.id}:x`, kind: 'model', provider: 'fable', operation: 'implement', amountMinor: 400 });
      const cap = await store.captureSpend(task.id, `${task.id}:x`, 250);
      assert.equal(cap.status, 'captured');
      assert.equal(cap.actualMinor, 250);
      let t = await store.getTask(task.id);
      assert.equal(t!.spentMinor, 250);
      assert.equal(t!.reservedMinor, 0);

      // Idempotent: a retried capture does not charge twice.
      await store.captureSpend(task.id, `${task.id}:x`, 250);
      assert.equal((await store.getTask(task.id))!.spentMinor, 250);

      await store.reserveSpend({ taskId: task.id, reservationId: `${task.id}:y`, kind: 'model', provider: 'fable', operation: 'implement', amountMinor: 100 });
      const over = await store.captureSpend(task.id, `${task.id}:y`, 180);
      assert.equal(over.actualMinor, 100, 'the customer is charged at most the reservation');
      assert.equal(over.overrunMinor, 80, 'the difference is recorded as RazeKit cost');
      t = await store.getTask(task.id);
      assert.equal(t!.spentMinor, 350);
      assert.ok(t!.spentMinor + t!.reservedMinor <= t!.maxBudgetMinor);
    });

    test('a released reservation is returned untouched and cannot then be captured', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}`, maxBudgetMinor: 1000 });
      await store.insertTask(task);
      await store.reserveSpend({ taskId: task.id, reservationId: `${task.id}:z`, kind: 'model', provider: 'astra', operation: 'plan', amountMinor: 500 });
      const rel = await store.releaseSpend(task.id, `${task.id}:z`);
      assert.equal(rel.status, 'released');
      assert.equal((await store.getTask(task.id))!.reservedMinor, 0);
      await assert.rejects(store.captureSpend(task.id, `${task.id}:z`, 10), isCode('DEV_CAPTURE_INVALID'));
    });

    test('the ceiling only ever goes up', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}`, maxBudgetMinor: 1000 });
      await store.insertTask(task);
      assert.equal(await store.raiseBudget(task.id, 800), false);
      assert.equal(await store.raiseBudget(task.id, 1500), true);
      assert.equal((await store.getTask(task.id))!.maxBudgetMinor, 1500);
    });

    test('events are append-only, newest first, filterable by kind', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      await store.insertTask(task);
      const base = { taskId: task.id, tenantId: task.tenantId, status: null, role: null, title: 't' };
      await store.appendEvent({ ...base, kind: 'update', message: 'one' });
      await store.appendEvent({ ...base, kind: 'chat', role: 'user', message: 'two' });
      await store.appendEvent({ ...base, kind: 'audit', message: 'three' });
      const all = await store.listEvents(task.id);
      assert.deepEqual(all.map((e) => e.message), ['three', 'two', 'one']);
      const chat = await store.listEvents(task.id, { kinds: ['chat'] });
      assert.deepEqual(chat.map((e) => e.message), ['two']);
      assert.equal(chat[0].role, 'user');
    });

    test('a change resolves once, from pending only', async () => {
      const task = makeTask({ userId: `u_${randomUUID()}` });
      await store.insertTask(task);
      const pending = await store.insertChange(change(task.id, task.tenantId, { status: 'pending', classification: 'boundary' }));
      const at = new Date().toISOString();
      const approved = await store.resolveChange(task.id, pending.id, 'approved', at);
      assert.equal(approved?.status, 'approved');
      assert.equal(await store.resolveChange(task.id, pending.id, 'denied', at), null, 'a resolved change cannot flip');
      await store.insertChange(change(task.id, task.tenantId));
      assert.equal((await store.listChanges(task.id)).length, 2);
      assert.equal((await store.listChanges(task.id, { status: ['pending'] })).length, 0);
      assert.equal(await store.getChange('some-other-task', pending.id), null);
    });

    test('the database itself refuses spend past the ceiling', { skip: f.name !== 'postgres' }, async () => {
      // Bypass every line of application code and ask Postgres directly. The
      // ceiling is a CHECK constraint, so even a governor bug cannot record it.
      const task = makeTask({ userId: `u_${randomUUID()}`, maxBudgetMinor: 1000 });
      await store.insertTask(task);
      const db = (store as any).db;
      await assert.rejects(
        db.$executeRawUnsafe(`UPDATE ${pgSchema}.tasks SET spent_minor = 1001 WHERE id = $1`, task.id),
        /tasks_budget_ceiling/
      );
    });

    test('silent workers go offline; control values round-trip', async () => {
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      await store.heartbeat({ id: `w_live_${f.name}`, hostname: 'h', capabilities: ['web'], capacity: 2, status: 'online', startedAt: now, lastHeartbeatAt: now });
      await store.heartbeat({ id: `w_dead_${f.name}`, hostname: 'h', capabilities: ['game'], capacity: 1, status: 'online', startedAt: old, lastHeartbeatAt: old });
      assert.ok((await store.markSilentWorkersOffline(60_000)) >= 1);
      const workers = await store.listWorkers();
      assert.equal(workers.find((w) => w.id === `w_dead_${f.name}`)?.status, 'offline');
      assert.equal(workers.find((w) => w.id === `w_live_${f.name}`)?.status, 'online');

      await store.setControl('execution', { paused: true, reason: 'test' });
      assert.deepEqual(await store.getControl('execution'), { paused: true, reason: 'test' });
      assert.equal(await store.getControl('nothing-here'), null);

      // claimOnce: of many racing claims, exactly one wins, and it stays won.
      const key = `once:${f.name}:${Date.now()}`;
      const wins = await Promise.all(Array.from({ length: 12 }, (_, i) => store.claimOnce(key, { by: i })));
      assert.equal(wins.filter(Boolean).length, 1);
      assert.equal(await store.claimOnce(key, { by: 'late' }), false);

      // Platform records: upsert, once-only insert under a race, newest first.
      const kind = `kind_${f.name}_${Date.now()}`;
      await store.putRecord(kind, 'a', { n: 1 });
      await new Promise((r) => setTimeout(r, 5));
      await store.putRecord(kind, 'b', { n: 2 });
      const a2 = await store.putRecord(kind, 'a', { n: 3 });
      assert.deepEqual(a2.data, { n: 3 });
      assert.deepEqual((await store.getRecord(kind, 'a'))!.data, { n: 3 });
      assert.equal(await store.getRecord(kind, 'missing'), null);
      assert.deepEqual((await store.listRecords(kind)).map((r) => r.key), ['b', 'a'], 'newest first, by creation');
      const inserted = await Promise.all(Array.from({ length: 8 }, (_, i) => store.insertRecordOnce(kind, 'once', { i })));
      assert.equal(inserted.filter(Boolean).length, 1);
      const stats = await store.queueStats();
      assert.ok(stats.total > 0);
    });
  });
}
