// DEV funding against the real ledger on a real Postgres.
//
// dev-money.test.ts proves the funding rules with an in-memory ledger. This
// proves the production unit of work — the real entity service, the real
// transaction, the per-user advisory lock — actually delivers them when
// several builds race for one balance over real connections.
//
// Runs only with DEV_TEST_DATABASE_URL pointing at a LOCAL database. It pushes
// the platform schema into a throwaway Postgres schema and drops it after, so
// it never touches anything it did not create.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DEV_TEST_DATABASE_URL || '';
const host = (() => { try { return new URL(BASE).hostname; } catch { return ''; } })();
const LOCAL = ['localhost', '127.0.0.1', '::1'].includes(host);
const skip = !BASE ? 'DEV_TEST_DATABASE_URL is not set' : !LOCAL ? 'DEV_TEST_DATABASE_URL is not a local database' : false;

const schema = `dev_ledger_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const url = BASE ? `${BASE}${BASE.includes('?') ? '&' : '?'}schema=${schema}` : '';
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let mod: any = null;

before(async () => {
  if (skip) return;
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    cwd: SERVER,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  // db.ts reads DATABASE_URL when it is first imported.
  process.env.DATABASE_URL = url;
  const [funding, unit, db] = await Promise.all([
    import('../src/development/funding.js'),
    import('../src/development/ledgerUnit.js'),
    import('../src/db.js'),
  ]);
  mod = { ...funding, ...unit, prisma: db.prisma };
});

after(async () => {
  if (!mod) return;
  await mod.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await mod.prisma.$disconnect();
});

const USD = 'USD';

function task(userId: string, maxBudgetMinor: number) {
  const id = `dtk_${randomUUID().replace(/-/g, '')}`;
  return { id, userId, maxBudgetMinor, spentMinor: 0, funding: { mode: 'ledger', reservations: [], settlement: null } } as any;
}

test('racing builds cannot overdraw one balance through the real ledger', { skip }, async () => {
  const { LedgerFunding, recordVerifiedPurchase, ledgerUnitOfWork, InsufficientFunds } = mod;
  const userId = `pg_user_${randomUUID().slice(0, 8)}`;
  await recordVerifiedPurchase(ledgerUnitOfWork, {
    userId, budgetMinor: 1500, paymentReference: `UTR-${randomUUID()}`, adminId: 'admin', currency: USD, platformFeeBps: 1500,
  });
  const funding = new LedgerFunding({ unitOfWork: ledgerUnitOfWork, currency: USD });

  const results = await Promise.allSettled(Array.from({ length: 4 }, () => funding.secure(task(userId, 600))));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 2, 'two builds of 600 fit in 1500');
  assert.ok(refused.every((r: any) => r.reason instanceof InsufficientFunds), 'the rest are refused for funds, not errors');

  const b = await funding.balances(userId);
  assert.equal(b.availableMinor, 300);
  assert.equal(b.reservedMinor, 1200);

  // A retried reservation is found through the real ledger and replayed.
  const t = task(userId, 300);
  const first = await funding.secure(t);
  const again = await funding.secure(t);
  assert.deepEqual(again, first);
  const after = await funding.balances(userId);
  assert.equal(after.availableMinor, 0);
  assert.equal(after.reservedMinor, 1500);
});

test('settlement through the real ledger is idempotent and conserves money', { skip }, async () => {
  const { LedgerFunding, recordVerifiedPurchase, ledgerUnitOfWork } = mod;
  const userId = `pg_user_${randomUUID().slice(0, 8)}`;
  await recordVerifiedPurchase(ledgerUnitOfWork, {
    userId, budgetMinor: 1000, paymentReference: `UTR-${randomUUID()}`, adminId: 'admin', currency: USD, platformFeeBps: 1500,
  });
  const funding = new LedgerFunding({ unitOfWork: ledgerUnitOfWork, currency: USD });
  const t = task(userId, 800);
  const r = await funding.secure(t);
  const finished = { ...t, spentMinor: 350, funding: { ...t.funding, reservations: [r] } };

  assert.deepEqual(await funding.settle(finished), { consumedMinor: 350, creditedMinor: 450 });
  await funding.settle(finished);
  const b = await funding.balances(userId);
  assert.deepEqual(
    { available: b.availableMinor, reserved: b.reservedMinor, consumed: b.consumedMinor, credit: b.creditMinor },
    { available: 200, reserved: 0, consumed: 350, credit: 450 }
  );
});
