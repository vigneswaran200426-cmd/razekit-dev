// The DEV store contract.
//
// One interface, two implementations: Postgres for anything real, memory for
// tests and a laptop. Both are held to the same contract test
// (server/test/dev-store.test.ts), so a behaviour the memory store gets right
// and Postgres gets wrong — or the reverse — fails the build.
//
// Three rules shape the interface:
//
//   • Budget columns are never written by a state save. spent, reserved and the
//     ceiling move only through reserve / capture / release / raise, each of
//     which is atomic on its own. A worker saving a transition therefore can
//     never overwrite money moved by a concurrent capture.
//   • Saves are compare-and-set on revision, and a worker's save also has to
//     present the lease it claimed with. A worker that lost its lease — because
//     it stalled and another worker recovered the task — cannot write stale
//     results over the new owner's.
//   • Events and change requests are append-only rows beside the task, not
//     fields inside it. A user asking for a change mid-build must not bump the
//     task's revision and throw away the tick a worker is halfway through.
import type {
  AgentType,
  DevChange,
  DevEvent,
  DevTask,
  SpendRecord,
  WorkerRecord,
} from '../engine/types.js';

export interface ClaimedTask {
  task: DevTask;
  leaseToken: string;
  leaseExpiresAt: string;
}

export type ReserveResult =
  | { ok: true; record: SpendRecord; replayed: boolean }
  | { ok: false; availableMinor: number };

export interface NewSpend {
  taskId: string;
  reservationId: string;
  kind: SpendRecord['kind'];
  provider: string;
  operation: string;
  amountMinor: number;
}

export type NewEvent = Omit<DevEvent, 'id' | 'createdAt'> & { createdAt?: string };

export interface QueueStats {
  runnable: number;
  leased: number;
  waiting: number;
  total: number;
}

export interface DevStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;

  /**
   * Inserts a new task. With a creation key, a second insert for the same
   * tenant and key returns the first task instead of creating another — a
   * double-clicked "Start build" is one build.
   */
  insertTask(task: DevTask, opts?: { creationKey?: string | null }): Promise<{ task: DevTask; created: boolean }>;
  /** With a tenant, a task belonging to anyone else reads as missing. */
  getTask(id: string, scope?: { tenantId: string }): Promise<DevTask | null>;
  listTasks(tenantId: string, opts?: { limit?: number }): Promise<DevTask[]>;
  /**
   * Compare-and-set on revision. Writes state and data; never the budget
   * columns. With a lease token, the caller must still hold that lease.
   * Throws DEV_CONFLICT or DEV_LEASE_LOST, never silently overwrites.
   */
  saveTask(task: DevTask, opts: { expectedRevision: number; leaseToken?: string }): Promise<DevTask>;

  /** Takes the next runnable task nobody holds a live lease on. */
  claimTask(workerId: string, opts: { leaseMs: number; agentTypes?: AgentType[] }): Promise<ClaimedTask | null>;
  extendLease(taskId: string, leaseToken: string, leaseMs: number): Promise<boolean>;
  /** Drops the lease. `retryAt` postpones the next run (backoff after a transient failure). */
  releaseLease(taskId: string, leaseToken: string, opts?: { retryAt?: string }): Promise<void>;

  reserveSpend(spend: NewSpend): Promise<ReserveResult>;
  /** Settles a reservation. Actual spend above the reservation is recorded as overrun, never charged. */
  captureSpend(taskId: string, reservationId: string, actualMinor: number): Promise<SpendRecord>;
  releaseSpend(taskId: string, reservationId: string): Promise<SpendRecord>;
  listSpend(taskId: string): Promise<SpendRecord[]>;
  /** Only ever raises the ceiling. Returns false if the new value is not higher. */
  raiseBudget(taskId: string, newMaxMinor: number): Promise<boolean>;

  appendEvent(event: NewEvent): Promise<DevEvent>;
  /** Newest first. */
  listEvents(taskId: string, opts?: { kinds?: DevEvent['kind'][]; limit?: number }): Promise<DevEvent[]>;

  insertChange(change: DevChange): Promise<DevChange>;
  getChange(taskId: string, changeId: string): Promise<DevChange | null>;
  /** Oldest first. */
  listChanges(taskId: string, opts?: { status?: DevChange['status'][] }): Promise<DevChange[]>;
  /** Moves a pending change to approved or denied. Returns null if it was not pending. */
  resolveChange(taskId: string, changeId: string, status: 'approved' | 'denied', at: string): Promise<DevChange | null>;

  heartbeat(worker: WorkerRecord): Promise<void>;
  listWorkers(): Promise<WorkerRecord[]>;
  /** Marks workers silent for longer than `silentForMs` offline. Returns how many. */
  markSilentWorkersOffline(silentForMs: number): Promise<number>;

  getControl<T = unknown>(key: string): Promise<T | null>;
  setControl(key: string, value: unknown): Promise<void>;
  /** Records `key` if it was never recorded. True for exactly one caller, ever. */
  claimOnce(key: string, value: unknown): Promise<boolean>;

  queueStats(): Promise<QueueStats>;

  // ── Platform records: DEV's own non-build state (telemetry, battles,
  //    benchmarks, incidents, Kit posts), in DEV's schema. ────────────────────
  /** Inserts or replaces the record (kind, key). */
  putRecord<T = unknown>(kind: string, key: string, data: T): Promise<PlatformRecord<T>>;
  /** Inserts only if (kind, key) does not exist. True when this call inserted it. */
  insertRecordOnce<T = unknown>(kind: string, key: string, data: T): Promise<boolean>;
  getRecord<T = unknown>(kind: string, key: string): Promise<PlatformRecord<T> | null>;
  /** Newest first. */
  listRecords<T = unknown>(kind: string, opts?: { limit?: number }): Promise<PlatformRecord<T>[]>;
}

export interface PlatformRecord<T = unknown> {
  kind: string;
  key: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}
