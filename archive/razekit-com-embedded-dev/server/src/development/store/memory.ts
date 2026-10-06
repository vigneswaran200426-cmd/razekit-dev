// In-memory DEV store, for tests and local development.
//
// It holds the same contract as the Postgres store, including the parts that
// only matter under concurrency — compare-and-set saves, lease fencing, the
// budget ceiling — because a memory store that is more forgiving than
// production hides exactly the bugs it exists to catch. Every read and write
// is a deep copy, so a caller mutating a returned task cannot change stored
// state behind the store's back.
//
// It is refused in production (see ../config.ts): a restart would lose every
// build and every reservation.
import { randomUUID } from 'node:crypto';
import { conflict, DevError, ERR } from '../engine/errors.js';
import type { DevChange, DevEvent, DevTask, SpendRecord, WorkerRecord } from '../engine/types.js';
import type { ClaimedTask, DevStore, NewEvent, NewSpend, QueueStats, ReserveResult } from './types.js';
import type { PlatformRecord } from './types.js';

type Lease = { owner: string; token: string; expiresAt: number };

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryDevStore implements DevStore {
  readonly kind = 'memory' as const;
  private tasks = new Map<string, DevTask>();
  private creationKeys = new Map<string, string>();
  private leases = new Map<string, Lease>();
  private spend = new Map<string, SpendRecord>();
  private events: DevEvent[] = [];
  private changes = new Map<string, DevChange>();
  private workers = new Map<string, WorkerRecord>();
  private control = new Map<string, unknown>();
  private records = new Map<string, PlatformRecord<any>>();
  private eventSeq = 0;
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  async init() {}
  async close() {}
  async health() {
    return { ok: true, detail: 'memory' };
  }

  async insertTask(task: DevTask, opts: { creationKey?: string | null } = {}) {
    if (opts.creationKey) {
      const key = `${task.tenantId}::${opts.creationKey}`;
      const existing = this.creationKeys.get(key);
      if (existing) return { task: clone(this.tasks.get(existing)!), created: false };
      this.creationKeys.set(key, task.id);
    }
    if (this.tasks.has(task.id)) throw conflict(`Task ${task.id} already exists.`);
    this.tasks.set(task.id, clone(task));
    return { task: clone(task), created: true };
  }

  async getTask(id: string, scope?: { tenantId: string }) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (scope && task.tenantId !== scope.tenantId) return null;
    return clone(task);
  }

  async listTasks(tenantId: string, opts: { limit?: number } = {}) {
    return [...this.tasks.values()]
      .filter((t) => t.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, opts.limit ?? 100)
      .map(clone);
  }

  async saveTask(task: DevTask, opts: { expectedRevision: number; leaseToken?: string }) {
    const current = this.tasks.get(task.id);
    if (!current) throw new DevError(ERR.NOT_FOUND, 'Build not found', { httpStatus: 404 });
    if (opts.leaseToken !== undefined) {
      const lease = this.leases.get(task.id);
      if (!lease || lease.token !== opts.leaseToken || lease.expiresAt <= this.now()) {
        throw new DevError(ERR.LEASE_LOST, 'This worker no longer holds the build.', { httpStatus: 409 });
      }
    }
    if (current.revision !== opts.expectedRevision) {
      throw conflict('The build changed while this update was being made.');
    }
    const saved: DevTask = {
      ...clone(task),
      // Budget columns are the store's, never the caller's.
      maxBudgetMinor: current.maxBudgetMinor,
      spentMinor: current.spentMinor,
      reservedMinor: current.reservedMinor,
      revision: current.revision + 1,
    };
    this.tasks.set(task.id, saved);
    return clone(saved);
  }

  async claimTask(workerId: string, opts: { leaseMs: number; agentTypes?: DevTask['agentType'][] }): Promise<ClaimedTask | null> {
    const now = this.now();
    const candidates = [...this.tasks.values()]
      .filter((t) => t.nextRunAt !== null && Date.parse(t.nextRunAt) <= now)
      .filter((t) => !opts.agentTypes || opts.agentTypes.includes(t.agentType))
      .filter((t) => {
        const lease = this.leases.get(t.id);
        return !lease || lease.expiresAt <= now;
      })
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!) || a.createdAt.localeCompare(b.createdAt));
    const task = candidates[0];
    if (!task) return null;
    const lease = { owner: workerId, token: randomUUID(), expiresAt: now + opts.leaseMs };
    this.leases.set(task.id, lease);
    return { task: clone(task), leaseToken: lease.token, leaseExpiresAt: new Date(lease.expiresAt).toISOString() };
  }

  async extendLease(taskId: string, leaseToken: string, leaseMs: number) {
    const lease = this.leases.get(taskId);
    if (!lease || lease.token !== leaseToken || lease.expiresAt <= this.now()) return false;
    lease.expiresAt = this.now() + leaseMs;
    return true;
  }

  async releaseLease(taskId: string, leaseToken: string, opts: { retryAt?: string } = {}) {
    const lease = this.leases.get(taskId);
    if (!lease || lease.token !== leaseToken) return;
    this.leases.delete(taskId);
    const task = this.tasks.get(taskId);
    if (task && opts.retryAt && task.nextRunAt !== null) task.nextRunAt = opts.retryAt;
  }

  async reserveSpend(s: NewSpend): Promise<ReserveResult> {
    const existing = this.spend.get(s.reservationId);
    if (existing) return { ok: true, record: clone(existing), replayed: true };
    const task = this.tasks.get(s.taskId);
    if (!task) throw new DevError(ERR.NOT_FOUND, 'Build not found', { httpStatus: 404 });
    const amount = Math.floor(s.amountMinor);
    if (!(amount >= 0)) throw new DevError(ERR.VALIDATION, 'A reservation must be a non-negative amount.');
    const available = task.maxBudgetMinor - task.spentMinor - task.reservedMinor;
    if (amount > available) return { ok: false, availableMinor: available };
    task.reservedMinor += amount;
    const record: SpendRecord = {
      reservationId: s.reservationId,
      taskId: s.taskId,
      kind: s.kind,
      provider: s.provider,
      operation: s.operation,
      reservedMinor: amount,
      actualMinor: null,
      overrunMinor: 0,
      status: 'reserved',
      createdAt: new Date(this.now()).toISOString(),
      settledAt: null,
    };
    this.spend.set(s.reservationId, record);
    return { ok: true, record: clone(record), replayed: false };
  }

  async captureSpend(taskId: string, reservationId: string, actualMinor: number) {
    const record = this.spend.get(reservationId);
    if (!record || record.taskId !== taskId) throw new DevError(ERR.NOT_FOUND, 'Reservation not found', { httpStatus: 404 });
    if (record.status === 'captured') return clone(record);
    if (record.status === 'released') throw new DevError(ERR.CAPTURE, 'A released reservation cannot be captured.');
    const actual = Math.max(0, Math.ceil(Number(actualMinor) || 0));
    const charged = Math.min(actual, record.reservedMinor);
    const task = this.tasks.get(taskId)!;
    task.reservedMinor -= record.reservedMinor;
    task.spentMinor += charged;
    Object.assign(record, {
      actualMinor: charged,
      overrunMinor: actual - charged,
      status: 'captured',
      settledAt: new Date(this.now()).toISOString(),
    });
    return clone(record);
  }

  async releaseSpend(taskId: string, reservationId: string) {
    const record = this.spend.get(reservationId);
    if (!record || record.taskId !== taskId) throw new DevError(ERR.NOT_FOUND, 'Reservation not found', { httpStatus: 404 });
    if (record.status === 'released') return clone(record);
    if (record.status === 'captured') throw new DevError(ERR.CAPTURE, 'A captured reservation cannot be released.');
    const task = this.tasks.get(taskId)!;
    task.reservedMinor -= record.reservedMinor;
    Object.assign(record, { status: 'released', actualMinor: 0, settledAt: new Date(this.now()).toISOString() });
    return clone(record);
  }

  async listSpend(taskId: string) {
    return [...this.spend.values()].filter((s) => s.taskId === taskId).map(clone);
  }

  async raiseBudget(taskId: string, newMaxMinor: number) {
    const task = this.tasks.get(taskId);
    if (!task || !(newMaxMinor > task.maxBudgetMinor)) return false;
    task.maxBudgetMinor = Math.floor(newMaxMinor);
    return true;
  }

  async appendEvent(e: NewEvent) {
    this.eventSeq += 1;
    const event: DevEvent = {
      ...clone(e),
      id: `ev_${String(this.eventSeq).padStart(8, '0')}`,
      createdAt: e.createdAt ?? new Date(this.now()).toISOString(),
    };
    this.events.push(event);
    return clone(event);
  }

  async listEvents(taskId: string, opts: { kinds?: DevEvent['kind'][]; limit?: number } = {}) {
    return this.events
      .filter((e) => e.taskId === taskId && (!opts.kinds || opts.kinds.includes(e.kind)))
      .reverse()
      .slice(0, opts.limit ?? 200)
      .map(clone);
  }

  async insertChange(change: DevChange) {
    if (this.changes.has(change.id)) throw conflict(`Change ${change.id} already exists.`);
    this.changes.set(change.id, clone(change));
    return clone(change);
  }

  async getChange(taskId: string, changeId: string) {
    const c = this.changes.get(changeId);
    return c && c.taskId === taskId ? clone(c) : null;
  }

  async listChanges(taskId: string, opts: { status?: DevChange['status'][] } = {}) {
    return [...this.changes.values()]
      .filter((c) => c.taskId === taskId && (!opts.status || opts.status.includes(c.status)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async resolveChange(taskId: string, changeId: string, status: 'approved' | 'denied', at: string) {
    const c = this.changes.get(changeId);
    if (!c || c.taskId !== taskId || c.status !== 'pending') return null;
    c.status = status;
    c.resolvedAt = at;
    return clone(c);
  }

  async heartbeat(worker: WorkerRecord) {
    const existing = this.workers.get(worker.id);
    this.workers.set(worker.id, clone({ ...worker, startedAt: existing?.startedAt ?? worker.startedAt }));
  }

  async listWorkers() {
    return [...this.workers.values()].map(clone);
  }

  async markSilentWorkersOffline(silentForMs: number) {
    let n = 0;
    for (const w of this.workers.values()) {
      if (w.status !== 'offline' && Date.parse(w.lastHeartbeatAt) < this.now() - silentForMs) {
        w.status = 'offline';
        n += 1;
      }
    }
    return n;
  }

  async getControl<T = unknown>(key: string) {
    return this.control.has(key) ? (clone(this.control.get(key)) as T) : null;
  }

  async setControl(key: string, value: unknown) {
    this.control.set(key, clone(value));
  }

  async putRecord<T>(kind: string, key: string, data: T): Promise<PlatformRecord<T>> {
    const id = `${kind}\u0000${key}`;
    const at = new Date(this.now()).toISOString();
    const rec = { kind, key, data: clone(data), createdAt: this.records.get(id)?.createdAt ?? at, updatedAt: at };
    this.records.set(id, rec);
    return clone(rec);
  }

  async insertRecordOnce<T>(kind: string, key: string, data: T) {
    if (this.records.has(`${kind}\u0000${key}`)) return false;
    await this.putRecord(kind, key, data);
    return true;
  }

  async getRecord<T>(kind: string, key: string): Promise<PlatformRecord<T> | null> {
    const r = this.records.get(`${kind}\u0000${key}`);
    return r ? clone(r) : null;
  }

  async listRecords<T>(kind: string, opts: { limit?: number } = {}): Promise<PlatformRecord<T>[]> {
    return [...this.records.values()]
      .filter((r) => r.kind === kind)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.key < b.key ? 1 : -1))
      .slice(0, opts.limit ?? 100)
      .map(clone);
  }

  async claimOnce(key: string, value: unknown) {
    if (this.control.has(key)) return false;
    this.control.set(key, clone(value));
    return true;
  }

  async queueStats(): Promise<QueueStats> {
    const now = this.now();
    let runnable = 0;
    let leased = 0;
    let waiting = 0;
    for (const t of this.tasks.values()) {
      const lease = this.leases.get(t.id);
      if (lease && lease.expiresAt > now) leased += 1;
      else if (t.nextRunAt !== null) runnable += 1;
      if (t.state === 'waiting_user' || t.state === 'awaiting_funding') waiting += 1;
    }
    return { runnable, leased, waiting, total: this.tasks.size };
  }
}
