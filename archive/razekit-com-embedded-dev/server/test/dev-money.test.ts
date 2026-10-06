// DEV money: the governor that gates every paid call, and the funding gate that
// ties a build's ceiling to real, purchased budget on the existing ledger.
//
// Tested the way money goes wrong: concurrent callers racing for the last of a
// budget, a call that fails after being billed, a worker that dies between
// capture and save, two builds started in the same instant against one
// balance, a settlement run twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { BudgetGovernor, BudgetExceeded, BilledFailure } from '../src/development/engine/governor.js';
import { MemoryDevStore } from '../src/development/store/memory.js';
import { LedgerFunding, NoFunding, InsufficientFunds, quoteBudgetPurchase, recordVerifiedPurchase } from '../src/development/funding.js';
import { makeTask, makeLedgerSvc, ledgerBalance, serialUnitOfWork } from './helpers/dev.js';

async function setup(maxBudgetMinor = 1000) {
  const store = new MemoryDevStore();
  const task = makeTask({ maxBudgetMinor });
  await store.insertTask(task);
  return { store, task, governor: new BudgetGovernor(store) };
}

const spec = (id: string, ceilingMinor: number) => ({ reservationId: id, kind: 'model' as const, provider: 'fable', operation: 'implement', ceilingMinor });

// ── Governor ──────────────────────────────────────────────────────────────────

test('a call is charged what it cost and the rest of its reservation returns at once', async () => {
  const { store, task, governor } = await setup();
  const out = await governor.run(task, spec('r1', 600), async () => ({ value: 'ok', costMinor: 240 }));
  assert.equal(out.value, 'ok');
  assert.equal(out.chargedMinor, 240);
  const t = await store.getTask(task.id);
  assert.equal(t!.spentMinor, 240);
  assert.equal(t!.reservedMinor, 0);
});

test('a call that could exceed the budget never starts', async () => {
  const { store, task, governor } = await setup(500);
  let called = false;
  await assert.rejects(
    governor.run(task, spec('r1', 501), async () => {
      called = true;
      return { value: null, costMinor: 0 };
    }),
    (e: unknown) => e instanceof BudgetExceeded && e.requiredMinor === 501 && e.availableMinor === 500 && e.retryable === false
  );
  assert.equal(called, false, 'the provider was never called');
  assert.equal((await store.getTask(task.id))!.reservedMinor, 0);
});

test('concurrent calls cannot both be approved against the last of a budget', async () => {
  const { store, task, governor } = await setup(1000);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      governor.run(task, spec(`c${i}`, 400), async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { value: i, costMinor: 400 };
      })
    )
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  const t = await store.getTask(task.id);
  assert.equal(t!.spentMinor, 800);
  assert.ok(t!.spentMinor <= t!.maxBudgetMinor);
});

test('a call that fails before answering is not charged', async () => {
  const { store, task, governor } = await setup();
  await assert.rejects(governor.run(task, spec('r1', 300), async () => { throw new Error('connection reset'); }), /connection reset/);
  const t = await store.getTask(task.id);
  assert.equal(t!.spentMinor, 0);
  assert.equal(t!.reservedMinor, 0);
  assert.equal((await store.listSpend(task.id))[0].status, 'released');
});

test('a call billed for an unusable answer is charged for it', async () => {
  const { store, task, governor } = await setup();
  await assert.rejects(
    governor.run(task, spec('r1', 300), async () => { throw new BilledFailure(new Error('invalid JSON'), 120); }),
    /invalid JSON/
  );
  assert.equal((await store.getTask(task.id))!.spentMinor, 120);
});

test('re-running a step a crashed worker already settled costs the customer nothing', async () => {
  const { store, task, governor } = await setup();
  await governor.run(task, spec('step-7', 300), async () => ({ value: 1, costMinor: 200 }));
  // The worker died before saving; the recovered tick runs the same step again.
  const again = await governor.run(task, spec('step-7', 300), async () => ({ value: 2, costMinor: 180 }));
  assert.equal(again.chargedMinor, 0);
  assert.equal(again.overrunMinor, 180, 'the re-run is recorded as RazeKit cost');
  assert.equal((await store.getTask(task.id))!.spentMinor, 200);
});

test('a provider bill above the reservation is never charged to the customer', async () => {
  const { store, task, governor } = await setup();
  const out = await governor.run(task, spec('r1', 100), async () => ({ value: 1, costMinor: 130 }));
  assert.equal(out.chargedMinor, 100);
  assert.equal(out.overrunMinor, 30);
  assert.equal((await store.getTask(task.id))!.spentMinor, 100);
});

// ── Funding gate ──────────────────────────────────────────────────────────────

const USD = 'USD';

async function funded(budgetMinor = 1500) {
  const svc = makeLedgerSvc();
  const unitOfWork = serialUnitOfWork(svc);
  const funding = new LedgerFunding({ unitOfWork, currency: USD });
  const userId = `user_${randomUUID().slice(0, 6)}`;
  await recordVerifiedPurchase(unitOfWork, {
    userId, budgetMinor, paymentReference: `pay_${randomUUID()}`, adminId: 'admin_1', currency: USD, platformFeeBps: 1500,
  });
  return { svc, unitOfWork, funding, userId };
}

/** The four DEV pots for one user. Their sum is conserved after the purchase. */
function pots(svc: ReturnType<typeof makeLedgerSvc>, userId: string) {
  const held = ledgerBalance(svc, 'DEV_BUDGET_HELD', userId);
  const reserved = ledgerBalance(svc, 'DEV_BUDGET_RESERVED', userId);
  const consumed = ledgerBalance(svc, 'DEV_BUDGET_CONSUMED', userId);
  const credit = ledgerBalance(svc, 'DEV_CREDIT', userId);
  return { held, reserved, consumed, credit, total: held + reserved + consumed + credit };
}

test('the platform fee comes from the fee engine: 15% of a $15 budget is $2.25', () => {
  const q = quoteBudgetPurchase(1500, { currency: USD, platformFeeBps: 1500 });
  assert.equal(q.platformFeeMinor, 225);
  assert.equal(q.totalMinor, 1725);
});

test('recording the same verified payment twice credits it once', async () => {
  const svc = makeLedgerSvc();
  const unitOfWork = serialUnitOfWork(svc);
  const input = { userId: 'u1', budgetMinor: 1500, paymentReference: 'UTR-123', adminId: 'a', currency: USD, platformFeeBps: 1500 };
  const first = await recordVerifiedPurchase(unitOfWork, input);
  const second = await recordVerifiedPurchase(unitOfWork, input);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(ledgerBalance(svc, 'DEV_BUDGET_HELD', 'u1'), 1500);
  assert.equal(ledgerBalance(svc, 'PLATFORM_FEE'), 225);
});

test('a build cannot start without its whole ceiling reserved from purchased budget', async () => {
  const { svc, funding, userId } = await funded(1500);
  const task = makeTask({ userId, maxBudgetMinor: 1000, fundingMode: 'ledger' });
  const r = await funding.secure(task);
  assert.deepEqual(r, { id: `task:${task.id}:budget`, amountMinor: 1000 });
  assert.deepEqual(await funding.balances(userId), { spendableMinor: 500, availableMinor: 500, reservedMinor: 1000, consumedMinor: 0, creditMinor: 0, currency: USD });

  const tooBig = makeTask({ userId, maxBudgetMinor: 600, fundingMode: 'ledger' });
  await assert.rejects(
    funding.secure(tooBig),
    (e: unknown) => e instanceof InsufficientFunds && e.availableMinor === 500 && e.httpStatus === 402 && /\$6\.00 .* \$5\.00 is available/.test(e.message)
  );
  assert.equal(pots(svc, userId).total, 1500);
});

test('two builds started at the same instant cannot both spend one balance', async () => {
  const { svc, funding, userId } = await funded(1500);
  const tasks = Array.from({ length: 3 }, () => makeTask({ userId, maxBudgetMinor: 600, fundingMode: 'ledger' }));
  const results = await Promise.allSettled(tasks.map((t) => funding.secure(t)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  const p = pots(svc, userId);
  assert.equal(p.held, 300);
  assert.equal(p.reserved, 1200);
  assert.ok(p.held >= 0, 'the held balance never goes negative');
});

test('settlement consumes what was spent, credits the rest, and is idempotent', async () => {
  const { svc, funding, userId } = await funded(1500);
  const task = makeTask({ userId, maxBudgetMinor: 1000, fundingMode: 'ledger' });
  const r = await funding.secure(task);
  const finished = { ...task, spentMinor: 420, funding: { ...task.funding, reservations: [r!] } };

  assert.deepEqual(await funding.settle(finished), { consumedMinor: 420, creditedMinor: 580 });
  const once = pots(svc, userId);
  assert.deepEqual({ held: once.held, reserved: once.reserved, consumed: once.consumed, credit: once.credit }, { held: 500, reserved: 0, consumed: 420, credit: 580 });

  await funding.settle(finished);
  assert.deepEqual(pots(svc, userId), once, 'a second settlement posts nothing');
  assert.equal(once.total, 1500, 'no money was created or destroyed');
});

test('a raised ceiling is reserved first, and settles across both reservations', async () => {
  const { svc, funding, userId } = await funded(2000);
  const task = makeTask({ userId, maxBudgetMinor: 1000, fundingMode: 'ledger' });
  const base = await funding.secure(task);
  const raise = await funding.secureIncrease(task, 500, 'chg_1');
  const finished = { ...task, spentMinor: 1200, funding: { ...task.funding, reservations: [base!, raise!] } };
  assert.deepEqual(await funding.settle(finished), { consumedMinor: 1200, creditedMinor: 300 });
  const p = pots(svc, userId);
  assert.equal(p.reserved, 0);
  assert.equal(p.consumed, 1200);
  assert.equal(p.credit, 300);
  assert.equal(p.held, 500);
  assert.equal(p.total, 2000);
});

test('a build that never ran gets everything back untouched', async () => {
  const { svc, funding, userId } = await funded(1500);
  const task = makeTask({ userId, maxBudgetMinor: 1000, fundingMode: 'ledger' });
  const r = await funding.secure(task);
  await funding.releaseAll({ ...task, funding: { ...task.funding, reservations: [r!] } });
  const p = pots(svc, userId);
  assert.equal(p.held, 1500);
  assert.equal(p.reserved, 0);
  assert.equal(p.consumed, 0);
});

test('without a funding mode, nothing is held and nothing is credited', async () => {
  const none = new NoFunding();
  const task = makeTask({ spentMinor: 300 });
  assert.equal(await none.secure(task), null);
  assert.equal(await none.balances(), null);
  assert.deepEqual(await none.settle(task), { consumedMinor: 300, creditedMinor: 0 });
});

test('credit from an earlier build pays for the next one, only as far as needed', async () => {
  const { svc, funding, userId } = await funded(1000);
  // First build: 600 ceiling, spends 200, so 400 comes back as credit.
  const first = makeTask({ userId, maxBudgetMinor: 600, fundingMode: 'ledger' });
  const r1 = await funding.secure(first);
  await funding.settle({ ...first, spentMinor: 200, funding: { ...first.funding, reservations: [r1!] } });
  assert.deepEqual(await funding.balances(userId), { spendableMinor: 800, availableMinor: 400, reservedMinor: 0, consumedMinor: 200, creditMinor: 400, currency: USD });

  // Second build needs 700: all 400 of purchased budget, and 300 of credit.
  const second = makeTask({ userId, maxBudgetMinor: 700, fundingMode: 'ledger' });
  await funding.secure(second);
  let p = pots(svc, userId);
  assert.equal(p.credit, 100, 'only the shortfall was drawn from credit');
  assert.equal(p.held, 0);
  assert.equal(p.reserved, 700);

  // A raise draws on the remaining credit as a separate, idempotent draw.
  await funding.secureIncrease(second, 100, 'chg_2');
  p = pots(svc, userId);
  assert.equal(p.credit, 0);
  assert.equal(p.reserved, 800);
  assert.equal(p.total, 1000, 'no money created or destroyed');

  // Nothing left anywhere: the next build is refused with the real total.
  await assert.rejects(
    funding.secure(makeTask({ userId, maxBudgetMinor: 100, fundingMode: 'ledger' })),
    (e: unknown) => e instanceof InsufficientFunds && e.availableMinor === 0
  );
});

test('retrying a reservation that already happened neither spends credit again nor refuses', async () => {
  const { svc, funding, userId } = await funded(1000);
  // Leave 400 purchased and 400 credit.
  const first = makeTask({ userId, maxBudgetMinor: 600, fundingMode: 'ledger' });
  const r1 = await funding.secure(first);
  await funding.settle({ ...first, spentMinor: 200, funding: { ...first.funding, reservations: [r1!] } });

  // A build that takes everything: 400 purchased + 400 credit.
  const task = makeTask({ userId, maxBudgetMinor: 800, fundingMode: 'ledger' });
  const once = await funding.secure(task);
  const before = pots(svc, userId);
  // The request that reserved it died before saving; the retry must be a replay.
  const again = await funding.secure(task);
  assert.deepEqual(again, once);
  assert.deepEqual(pots(svc, userId), before, 'nothing moved on the retry');
  assert.equal(before.reserved, 800);
  assert.equal(before.credit, 0);
});

test('settlement finds a reservation the build never recorded', async () => {
  const { svc, funding, userId } = await funded(1000);
  const task = makeTask({ userId, maxBudgetMinor: 600, fundingMode: 'ledger' });
  await funding.secure(task);
  // The process died before the build recorded its reservation; the user
  // then stopped it. Settlement reads the ledger, not the build's own list.
  const settled = await funding.settle({ ...task, spentMinor: 0, funding: { ...task.funding, reservations: [] } });
  assert.deepEqual(settled, { consumedMinor: 0, creditedMinor: 600 });
  const p = pots(svc, userId);
  assert.equal(p.reserved, 0, 'nothing left stranded in reserved');
  assert.equal(p.total, 1000);
});
