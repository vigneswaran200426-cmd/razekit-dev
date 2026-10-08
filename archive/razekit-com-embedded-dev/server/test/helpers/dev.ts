// Shared fixtures for the RazeKit DEV tests. Not a test file itself: the
// runner only picks up test/*.test.ts.
import { analyze } from '../../src/development/engine/preflight.js';
import { buildTask } from '../../src/development/engine/task.js';
import { defaultAvailability } from '../../src/development/engine/tools.js';
import type { DevTask, TaskType } from '../../src/development/engine/types.js';

export const PRICING = {
  astra: { inputMinorPerMTok: 125, outputMinorPerMTok: 1000 },
  fable: { inputMinorPerMTok: 1000, outputMinorPerMTok: 5000 },
  currency: 'USD',
};

export function makeTask(overrides: Partial<DevTask> & { taskType?: TaskType; userId?: string; fundingMode?: 'none' | 'ledger' } = {}): DevTask {
  const taskType = overrides.taskType ?? 'website';
  const originalRequest =
    overrides.originalRequest ?? 'A responsive landing page with a navigation bar, hero section, call to action and footer.';
  const preflight = analyze({ taskType, originalRequest }, PRICING, defaultAvailability());
  const base = buildTask({
    userId: overrides.userId ?? 'user_a',
    taskType,
    title: overrides.title ?? 'Landing page',
    originalRequest,
    maxBudgetMinor: overrides.maxBudgetMinor ?? 2500,
    currency: 'USD',
    preflight,
    userCriteria: [],
    fundingMode: overrides.fundingMode ?? 'none',
  });
  const { fundingMode: _f, ...rest } = overrides;
  // An explicit undefined means "use the default", not "blank this field".
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return { ...base, ...defined };
}

/**
 * An in-memory stand-in for the entity service the ledger posts through.
 * Records every entry, so balances are replayed from entries exactly as the
 * real ledger replays them.
 */
export function makeLedgerSvc() {
  const tables: Record<string, any[]> = { LedgerTransaction: [], LedgerEntry: [], LedgerAccount: [] };
  let seq = 0;
  const collection = (rows: any[]) => ({
    async filter(where: Record<string, unknown>, sort?: string, limit?: number) {
      let out = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      if (sort === 'sequence') out = [...out].sort((a, b) => a.sequence - b.sequence);
      if (sort === '-created_date') out = [...out].reverse();
      return typeof limit === 'number' ? out.slice(0, limit) : out;
    },
    async create(row: any) {
      const created = { id: `id_${(seq += 1)}`, created_date: new Date().toISOString(), ...row };
      rows.push(created);
      return created;
    },
    async update(id: string, patch: any) {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, patch);
      return row;
    },
  });
  const svc = {
    entities: {
      LedgerTransaction: collection(tables.LedgerTransaction),
      LedgerEntry: collection(tables.LedgerEntry),
      LedgerAccount: collection(tables.LedgerAccount),
    },
    tables,
  };
  return svc;
}

/** Credit-positive balance of an account class, replayed from entries. */
export function ledgerBalance(svc: ReturnType<typeof makeLedgerSvc>, accountClass: string, ownerId?: string) {
  return svc.tables.LedgerEntry
    .filter((e) => e.account_class === accountClass && (ownerId ? e.owner_id === ownerId : true))
    .reduce((sum, e) => sum + (e.direction === 'CREDIT' ? e.amount_minor : -e.amount_minor), 0);
}

/** A unit of work over the fake service that serialises per user, like the advisory lock does. */
export function serialUnitOfWork(svc: ReturnType<typeof makeLedgerSvc>) {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(userId: string, fn: (s: any) => Promise<T>): Promise<T> => {
    const prev = chains.get(userId) ?? Promise.resolve();
    const next = prev.then(() => fn(svc), () => fn(svc));
    chains.set(userId, next.catch(() => undefined));
    return next;
  };
}
