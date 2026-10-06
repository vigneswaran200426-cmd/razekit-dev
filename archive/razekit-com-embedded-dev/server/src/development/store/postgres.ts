// Postgres DEV store.
//
// DEV owns its own schema, `razekit_dev`, and never touches the marketplace's
// `records` table. It can share the marketplace's database or live on its own
// (DEV_DATABASE_URL); either way it has its own connection pool, so a build
// storm cannot starve the contest API of connections.
//
// The shape is typed columns for everything the database must enforce, and one
// JSONB column for the task's working documents (plans, results, evidence):
//
//   • spent + reserved <= ceiling is a CHECK constraint. Even a bug in the
//     governor cannot make the database record a build spending more than the
//     user allowed.
//   • A reservation id is a primary key, so a retried model call reserves once.
//   • (tenant, creation key) is unique, so a double-submitted build is one build.
//   • Work is claimed with FOR UPDATE SKIP LOCKED: any number of workers poll
//     the same table and never take the same build, and never block each other
//     waiting to find out.
//
// The schema is created idempotently on start. Every statement is IF NOT
// EXISTS, and a version row records what was applied, so a future change is an
// additive step rather than a rewrite.
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { conflict, DevError, ERR } from '../engine/errors.js';
import { TASK_STATE, TASK_TYPES, AGENT_TYPES, type DevChange, type DevEvent, type DevTask, type SpendRecord, type WorkerRecord } from '../engine/types.js';
import type { ClaimedTask, DevStore, NewEvent, NewSpend, QueueStats, ReserveResult, PlatformRecord } from './types.js';

const SCHEMA_VERSION = 1;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,40}$/;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

function ddl(s: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${s}`,
    `CREATE TABLE IF NOT EXISTS ${s}.meta (
       key text PRIMARY KEY,
       value jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS ${s}.tasks (
       id text PRIMARY KEY,
       tenant_id text NOT NULL,
       user_id text NOT NULL,
       task_type text NOT NULL CHECK (task_type IN (${list(TASK_TYPES)})),
       agent_type text NOT NULL CHECK (agent_type IN (${list(AGENT_TYPES)})),
       state text NOT NULL CHECK (state IN (${list(Object.values(TASK_STATE))})),
       title text NOT NULL,
       max_budget_minor integer NOT NULL CHECK (max_budget_minor > 0),
       spent_minor integer NOT NULL DEFAULT 0 CHECK (spent_minor >= 0),
       reserved_minor integer NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
       currency text NOT NULL,
       revision integer NOT NULL DEFAULT 0,
       creation_key text,
       data jsonb NOT NULL,
       next_run_at timestamptz,
       lease_owner text,
       lease_token text,
       lease_expires_at timestamptz,
       created_at timestamptz NOT NULL,
       updated_at timestamptz NOT NULL,
       CONSTRAINT tasks_budget_ceiling CHECK (spent_minor + reserved_minor <= max_budget_minor)
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tasks_creation_key_uniq ON ${s}.tasks (tenant_id, creation_key) WHERE creation_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS tasks_tenant_created_idx ON ${s}.tasks (tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS tasks_runnable_idx ON ${s}.tasks (next_run_at) WHERE next_run_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${s}.spend (
       reservation_id text PRIMARY KEY,
       task_id text NOT NULL REFERENCES ${s}.tasks(id) ON DELETE CASCADE,
       kind text NOT NULL CHECK (kind IN ('model', 'compute')),
       provider text NOT NULL,
       operation text NOT NULL,
       reserved_minor integer NOT NULL CHECK (reserved_minor >= 0),
       actual_minor integer CHECK (actual_minor >= 0),
       overrun_minor integer NOT NULL DEFAULT 0 CHECK (overrun_minor >= 0),
       status text NOT NULL CHECK (status IN ('reserved', 'captured', 'released')),
       created_at timestamptz NOT NULL DEFAULT now(),
       settled_at timestamptz
     )`,
    `CREATE INDEX IF NOT EXISTS spend_task_idx ON ${s}.spend (task_id)`,
    `CREATE TABLE IF NOT EXISTS ${s}.events (
       id bigserial PRIMARY KEY,
       task_id text NOT NULL REFERENCES ${s}.tasks(id) ON DELETE CASCADE,
       tenant_id text NOT NULL,
       kind text NOT NULL CHECK (kind IN ('update', 'chat', 'audit')),
       status text,
       role text CHECK (role IS NULL OR role IN ('user', 'assistant', 'system')),
       title text NOT NULL,
       message text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS events_task_idx ON ${s}.events (task_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS ${s}.changes (
       id text PRIMARY KEY,
       task_id text NOT NULL REFERENCES ${s}.tasks(id) ON DELETE CASCADE,
       tenant_id text NOT NULL,
       content text NOT NULL,
       classification text NOT NULL CHECK (classification IN ('refinement', 'boundary', 'out_of_scope')),
       status text NOT NULL CHECK (status IN ('applied', 'pending', 'approved', 'denied')),
       reason text NOT NULL,
       budget_snapshot jsonb NOT NULL,
       created_at timestamptz NOT NULL,
       resolved_at timestamptz
     )`,
    `CREATE INDEX IF NOT EXISTS changes_task_idx ON ${s}.changes (task_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ${s}.workers (
       id text PRIMARY KEY,
       hostname text NOT NULL,
       capabilities jsonb NOT NULL,
       capacity integer NOT NULL CHECK (capacity > 0),
       status text NOT NULL CHECK (status IN ('online', 'draining', 'offline')),
       started_at timestamptz NOT NULL,
       last_heartbeat_at timestamptz NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS ${s}.control (
       key text PRIMARY KEY,
       value jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS ${s}.records (
       kind text NOT NULL,
       key text NOT NULL,
       data jsonb NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (kind, key)
     )`,
    `CREATE INDEX IF NOT EXISTS records_kind_created_idx ON ${s}.records (kind, created_at DESC)`,
  ];
}

// Fields with their own column. Everything else in a task lives in `data`.
const COLUMN_FIELDS = new Set([
  'id', 'tenantId', 'userId', 'taskType', 'agentType', 'state', 'title', 'maxBudgetMinor', 'spentMinor',
  'reservedMinor', 'currency', 'revision', 'nextRunAt', 'createdAt', 'updatedAt',
]);

function taskData(task: DevTask): string {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(task)) if (!COLUMN_FIELDS.has(k)) data[k] = v;
  return JSON.stringify(data);
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

function rowToTask(r: any): DevTask {
  return {
    ...(r.data as object),
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    taskType: r.task_type,
    agentType: r.agent_type,
    state: r.state,
    title: r.title,
    maxBudgetMinor: Number(r.max_budget_minor),
    spentMinor: Number(r.spent_minor),
    reservedMinor: Number(r.reserved_minor),
    currency: r.currency,
    revision: Number(r.revision),
    nextRunAt: iso(r.next_run_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  } as DevTask;
}

function rowToSpend(r: any): SpendRecord {
  return {
    reservationId: r.reservation_id,
    taskId: r.task_id,
    kind: r.kind,
    provider: r.provider,
    operation: r.operation,
    reservedMinor: Number(r.reserved_minor),
    actualMinor: r.actual_minor == null ? null : Number(r.actual_minor),
    overrunMinor: Number(r.overrun_minor),
    status: r.status,
    createdAt: iso(r.created_at)!,
    settledAt: iso(r.settled_at),
  };
}

function rowToEvent(r: any): DevEvent {
  return {
    id: `ev_${String(r.id).padStart(8, '0')}`,
    taskId: r.task_id,
    tenantId: r.tenant_id,
    kind: r.kind,
    status: r.status,
    role: r.role,
    title: r.title,
    message: r.message,
    createdAt: iso(r.created_at)!,
  };
}

function rowToChange(r: any): DevChange {
  return {
    id: r.id,
    taskId: r.task_id,
    tenantId: r.tenant_id,
    content: r.content,
    classification: r.classification,
    status: r.status,
    reason: r.reason,
    budgetSnapshot: r.budget_snapshot,
    createdAt: iso(r.created_at)!,
    resolvedAt: iso(r.resolved_at),
  };
}

function rowToWorker(r: any): WorkerRecord {
  return {
    id: r.id,
    hostname: r.hostname,
    capabilities: r.capabilities,
    capacity: Number(r.capacity),
    status: r.status,
    startedAt: iso(r.started_at)!,
    lastHeartbeatAt: iso(r.last_heartbeat_at)!,
  };
}

/** Rolls a transaction back without it being an error to the caller. */
class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('rollback');
  }
}

export class PostgresDevStore implements DevStore {
  readonly kind = 'postgres' as const;
  private db: PrismaClient;
  private s: string;
  private ownsClient: boolean;

  constructor(opts: { url?: string; client?: PrismaClient; schema?: string }) {
    const schema = opts.schema ?? 'razekit_dev';
    if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid DEV schema name: ${schema}`);
    this.s = schema;
    if (opts.client) {
      this.db = opts.client;
      this.ownsClient = false;
    } else {
      if (!opts.url) throw new Error('A database URL is required for the Postgres DEV store.');
      this.db = new PrismaClient({ datasources: { db: { url: opts.url } }, log: ['error'] });
      this.ownsClient = true;
    }
  }

  private q<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.$queryRawUnsafe<T[]>(sql, ...params);
  }

  async init() {
    // One statement at a time: the extended protocol Prisma uses for raw
    // queries does not accept several statements in one call.
    for (const stmt of ddl(this.s)) await this.db.$executeRawUnsafe(stmt);
    await this.db.$executeRawUnsafe(
      `INSERT INTO ${this.s}.meta (key, value) VALUES ('schema_version', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE (${this.s}.meta.value)::int < (EXCLUDED.value)::int`,
      JSON.stringify(SCHEMA_VERSION)
    );
  }

  async close() {
    if (this.ownsClient) await this.db.$disconnect();
  }

  async health() {
    try {
      const rows = await this.q<{ v: number }>(`SELECT (value)::int AS v FROM ${this.s}.meta WHERE key = 'schema_version'`);
      if (!rows.length) return { ok: false, detail: 'schema not initialised' };
      return { ok: true, detail: `postgres schema ${this.s} v${rows[0].v}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message.split('\n')[0].slice(0, 200) };
    }
  }

  async insertTask(task: DevTask, opts: { creationKey?: string | null } = {}) {
    const rows = await this.q(
      `INSERT INTO ${this.s}.tasks
         (id, tenant_id, user_id, task_type, agent_type, state, title, max_budget_minor, spent_minor,
          reserved_minor, currency, revision, creation_key, data, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $9, 0, $10, $11::jsonb, $12::timestamptz, $13::timestamptz, $14::timestamptz)
       ON CONFLICT (tenant_id, creation_key) WHERE creation_key IS NOT NULL DO NOTHING
       RETURNING *`,
      task.id, task.tenantId, task.userId, task.taskType, task.agentType, task.state, task.title,
      task.maxBudgetMinor, task.currency, opts.creationKey ?? null, taskData(task), task.nextRunAt,
      task.createdAt, task.updatedAt
    );
    if (rows.length) return { task: rowToTask(rows[0]), created: true };
    const existing = await this.q(
      `SELECT * FROM ${this.s}.tasks WHERE tenant_id = $1 AND creation_key = $2`,
      task.tenantId,
      opts.creationKey ?? null
    );
    if (!existing.length) throw conflict('The build could not be created.');
    return { task: rowToTask(existing[0]), created: false };
  }

  async getTask(id: string, scope?: { tenantId: string }) {
    const rows = scope
      ? await this.q(`SELECT * FROM ${this.s}.tasks WHERE id = $1 AND tenant_id = $2`, id, scope.tenantId)
      : await this.q(`SELECT * FROM ${this.s}.tasks WHERE id = $1`, id);
    return rows.length ? rowToTask(rows[0]) : null;
  }

  async listTasks(tenantId: string, opts: { limit?: number } = {}) {
    const rows = await this.q(
      `SELECT * FROM ${this.s}.tasks WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      tenantId,
      Math.min(Math.max(opts.limit ?? 100, 1), 500)
    );
    return rows.map(rowToTask);
  }

  async saveTask(task: DevTask, opts: { expectedRevision: number; leaseToken?: string }) {
    const rows = await this.q(
      `UPDATE ${this.s}.tasks
          SET state = $2, title = $3, data = $4::jsonb, next_run_at = $5::timestamptz,
              updated_at = $6::timestamptz, revision = revision + 1
        WHERE id = $1 AND revision = $7
          AND ($8::text IS NULL OR (lease_token = $8 AND lease_expires_at > now()))
        RETURNING *`,
      task.id, task.state, task.title, taskData(task), task.nextRunAt, task.updatedAt,
      opts.expectedRevision, opts.leaseToken ?? null
    );
    if (rows.length) return rowToTask(rows[0]);

    // Say which of the three it was: the caller handles each differently.
    const current = await this.q(
      `SELECT revision, lease_token, (lease_expires_at > now()) AS live FROM ${this.s}.tasks WHERE id = $1`,
      task.id
    );
    if (!current.length) throw new DevError(ERR.NOT_FOUND, 'Build not found', { httpStatus: 404 });
    if (opts.leaseToken !== undefined && (current[0].lease_token !== opts.leaseToken || !current[0].live)) {
      throw new DevError(ERR.LEASE_LOST, 'This worker no longer holds the build.', { httpStatus: 409 });
    }
    throw conflict('The build changed while this update was being made.');
  }

  async claimTask(workerId: string, opts: { leaseMs: number; agentTypes?: DevTask['agentType'][] }): Promise<ClaimedTask | null> {
    const token = randomUUID();
    const rows = await this.q(
      `UPDATE ${this.s}.tasks
          SET lease_owner = $1, lease_token = $2,
              lease_expires_at = now() + make_interval(secs => $3::double precision / 1000)
        WHERE id = (
          SELECT id FROM ${this.s}.tasks
           WHERE next_run_at IS NOT NULL AND next_run_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at <= now())
             AND ($4::text[] IS NULL OR agent_type = ANY($4::text[]))
           ORDER BY next_run_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
      workerId,
      token,
      opts.leaseMs,
      opts.agentTypes ?? null
    );
    if (!rows.length) return null;
    return { task: rowToTask(rows[0]), leaseToken: token, leaseExpiresAt: iso(rows[0].lease_expires_at)! };
  }

  async extendLease(taskId: string, leaseToken: string, leaseMs: number) {
    const rows = await this.q(
      `UPDATE ${this.s}.tasks SET lease_expires_at = now() + make_interval(secs => $3::double precision / 1000)
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > now() RETURNING id`,
      taskId,
      leaseToken,
      leaseMs
    );
    return rows.length > 0;
  }

  async releaseLease(taskId: string, leaseToken: string, opts: { retryAt?: string } = {}) {
    await this.q(
      `UPDATE ${this.s}.tasks
          SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              next_run_at = CASE WHEN next_run_at IS NOT NULL AND $3::timestamptz IS NOT NULL THEN $3::timestamptz ELSE next_run_at END
        WHERE id = $1 AND lease_token = $2
        RETURNING id`,
      taskId,
      leaseToken,
      opts.retryAt ?? null
    );
  }

  async reserveSpend(s: NewSpend): Promise<ReserveResult> {
    const amount = Math.floor(s.amountMinor);
    if (!(amount >= 0)) throw new DevError(ERR.VALIDATION, 'A reservation must be a non-negative amount.');
    try {
      return await this.db.$transaction(async (tx) => {
        const inserted = await tx.$queryRawUnsafe<any[]>(
          `INSERT INTO ${this.s}.spend (reservation_id, task_id, kind, provider, operation, reserved_minor, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'reserved')
           ON CONFLICT (reservation_id) DO NOTHING
           RETURNING *`,
          s.reservationId, s.taskId, s.kind, s.provider, s.operation, amount
        );
        if (!inserted.length) {
          const existing = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM ${this.s}.spend WHERE reservation_id = $1`,
            s.reservationId
          );
          return { ok: true as const, record: rowToSpend(existing[0]), replayed: true };
        }
        const updated = await tx.$queryRawUnsafe<any[]>(
          `UPDATE ${this.s}.tasks SET reserved_minor = reserved_minor + $2
            WHERE id = $1 AND spent_minor + reserved_minor + $2 <= max_budget_minor
            RETURNING id`,
          s.taskId,
          amount
        );
        if (!updated.length) {
          const t = await tx.$queryRawUnsafe<any[]>(
            `SELECT max_budget_minor - spent_minor - reserved_minor AS available FROM ${this.s}.tasks WHERE id = $1`,
            s.taskId
          );
          throw new Rollback({ ok: false as const, availableMinor: Number(t[0]?.available ?? 0) });
        }
        return { ok: true as const, record: rowToSpend(inserted[0]), replayed: false };
      });
    } catch (e) {
      if (e instanceof Rollback) return e.value as ReserveResult;
      if (/violates foreign key/i.test(String((e as Error).message))) {
        throw new DevError(ERR.NOT_FOUND, 'Build not found', { httpStatus: 404 });
      }
      throw e;
    }
  }

  async captureSpend(taskId: string, reservationId: string, actualMinor: number) {
    const actual = Math.max(0, Math.ceil(Number(actualMinor) || 0));
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM ${this.s}.spend WHERE reservation_id = $1 AND task_id = $2 FOR UPDATE`,
        reservationId,
        taskId
      );
      if (!rows.length) throw new DevError(ERR.NOT_FOUND, 'Reservation not found', { httpStatus: 404 });
      const record = rowToSpend(rows[0]);
      if (record.status === 'captured') return record;
      if (record.status === 'released') throw new DevError(ERR.CAPTURE, 'A released reservation cannot be captured.');
      const charged = Math.min(actual, record.reservedMinor);
      const updated = await tx.$queryRawUnsafe<any[]>(
        `UPDATE ${this.s}.spend SET status = 'captured', actual_minor = $2, overrun_minor = $3, settled_at = now()
          WHERE reservation_id = $1 RETURNING *`,
        reservationId,
        charged,
        actual - charged
      );
      await tx.$executeRawUnsafe(
        `UPDATE ${this.s}.tasks SET reserved_minor = reserved_minor - $2, spent_minor = spent_minor + $3 WHERE id = $1`,
        taskId,
        record.reservedMinor,
        charged
      );
      return rowToSpend(updated[0]);
    });
  }

  async releaseSpend(taskId: string, reservationId: string) {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM ${this.s}.spend WHERE reservation_id = $1 AND task_id = $2 FOR UPDATE`,
        reservationId,
        taskId
      );
      if (!rows.length) throw new DevError(ERR.NOT_FOUND, 'Reservation not found', { httpStatus: 404 });
      const record = rowToSpend(rows[0]);
      if (record.status === 'released') return record;
      if (record.status === 'captured') throw new DevError(ERR.CAPTURE, 'A captured reservation cannot be released.');
      const updated = await tx.$queryRawUnsafe<any[]>(
        `UPDATE ${this.s}.spend SET status = 'released', actual_minor = 0, settled_at = now()
          WHERE reservation_id = $1 RETURNING *`,
        reservationId
      );
      await tx.$executeRawUnsafe(
        `UPDATE ${this.s}.tasks SET reserved_minor = reserved_minor - $2 WHERE id = $1`,
        taskId,
        record.reservedMinor
      );
      return rowToSpend(updated[0]);
    });
  }

  async listSpend(taskId: string) {
    const rows = await this.q(`SELECT * FROM ${this.s}.spend WHERE task_id = $1 ORDER BY created_at, reservation_id`, taskId);
    return rows.map(rowToSpend);
  }

  async raiseBudget(taskId: string, newMaxMinor: number) {
    const rows = await this.q(
      `UPDATE ${this.s}.tasks SET max_budget_minor = $2 WHERE id = $1 AND max_budget_minor < $2 RETURNING id`,
      taskId,
      Math.floor(newMaxMinor)
    );
    return rows.length > 0;
  }

  async appendEvent(e: NewEvent) {
    const rows = await this.q(
      `INSERT INTO ${this.s}.events (task_id, tenant_id, kind, status, role, title, message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
       RETURNING *`,
      e.taskId, e.tenantId, e.kind, e.status, e.role, e.title, e.message, e.createdAt ?? null
    );
    return rowToEvent(rows[0]);
  }

  async listEvents(taskId: string, opts: { kinds?: DevEvent['kind'][]; limit?: number } = {}) {
    const rows = await this.q(
      `SELECT * FROM ${this.s}.events WHERE task_id = $1 AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
        ORDER BY id DESC LIMIT $3`,
      taskId,
      opts.kinds ?? null,
      Math.min(Math.max(opts.limit ?? 200, 1), 1000)
    );
    return rows.map(rowToEvent);
  }

  async insertChange(c: DevChange) {
    const rows = await this.q(
      `INSERT INTO ${this.s}.changes (id, task_id, tenant_id, content, classification, status, reason, budget_snapshot, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz)
       RETURNING *`,
      c.id, c.taskId, c.tenantId, c.content, c.classification, c.status, c.reason,
      JSON.stringify(c.budgetSnapshot), c.createdAt, c.resolvedAt
    );
    return rowToChange(rows[0]);
  }

  async getChange(taskId: string, changeId: string) {
    const rows = await this.q(`SELECT * FROM ${this.s}.changes WHERE id = $1 AND task_id = $2`, changeId, taskId);
    return rows.length ? rowToChange(rows[0]) : null;
  }

  async listChanges(taskId: string, opts: { status?: DevChange['status'][] } = {}) {
    const rows = await this.q(
      `SELECT * FROM ${this.s}.changes WHERE task_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        ORDER BY created_at, id`,
      taskId,
      opts.status ?? null
    );
    return rows.map(rowToChange);
  }

  async resolveChange(taskId: string, changeId: string, status: 'approved' | 'denied', at: string) {
    const rows = await this.q(
      `UPDATE ${this.s}.changes SET status = $3, resolved_at = $4::timestamptz
        WHERE id = $1 AND task_id = $2 AND status = 'pending' RETURNING *`,
      changeId,
      taskId,
      status,
      at
    );
    return rows.length ? rowToChange(rows[0]) : null;
  }

  async heartbeat(w: WorkerRecord) {
    await this.db.$executeRawUnsafe(
      `INSERT INTO ${this.s}.workers (id, hostname, capabilities, capacity, status, started_at, last_heartbeat_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (id) DO UPDATE SET hostname = EXCLUDED.hostname, capabilities = EXCLUDED.capabilities,
         capacity = EXCLUDED.capacity, status = EXCLUDED.status, last_heartbeat_at = EXCLUDED.last_heartbeat_at`,
      w.id, w.hostname, JSON.stringify(w.capabilities), w.capacity, w.status, w.startedAt, w.lastHeartbeatAt
    );
  }

  async listWorkers() {
    const rows = await this.q(`SELECT * FROM ${this.s}.workers ORDER BY last_heartbeat_at DESC`);
    return rows.map(rowToWorker);
  }

  async markSilentWorkersOffline(silentForMs: number) {
    const rows = await this.q(
      `UPDATE ${this.s}.workers SET status = 'offline'
        WHERE status <> 'offline' AND last_heartbeat_at < now() - make_interval(secs => $1::double precision / 1000)
        RETURNING id`,
      silentForMs
    );
    return rows.length;
  }

  async getControl<T = unknown>(key: string) {
    const rows = await this.q(`SELECT value FROM ${this.s}.control WHERE key = $1`, key);
    return rows.length ? (rows[0].value as T) : null;
  }

  private toRecord(r: any): PlatformRecord<any> {
    return { kind: r.kind, key: r.key, data: r.data, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() };
  }

  async putRecord<T>(kind: string, key: string, data: T): Promise<PlatformRecord<T>> {
    const rows = await this.q(
      `INSERT INTO ${this.s}.records (kind, key, data) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (kind, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       RETURNING *`,
      kind,
      key,
      JSON.stringify(data)
    );
    return this.toRecord(rows[0]);
  }

  async insertRecordOnce<T>(kind: string, key: string, data: T) {
    const rows = await this.q(
      `INSERT INTO ${this.s}.records (kind, key, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (kind, key) DO NOTHING RETURNING key`,
      kind,
      key,
      JSON.stringify(data)
    );
    return rows.length === 1;
  }

  async getRecord<T>(kind: string, key: string): Promise<PlatformRecord<T> | null> {
    const rows = await this.q(`SELECT * FROM ${this.s}.records WHERE kind = $1 AND key = $2`, kind, key);
    return rows.length ? this.toRecord(rows[0]) : null;
  }

  async listRecords<T>(kind: string, opts: { limit?: number } = {}): Promise<PlatformRecord<T>[]> {
    const rows = await this.q(
      `SELECT * FROM ${this.s}.records WHERE kind = $1 ORDER BY created_at DESC, key DESC LIMIT $2`,
      kind,
      Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    );
    return rows.map((r) => this.toRecord(r));
  }

  async claimOnce(key: string, value: unknown) {
    const rows = await this.q(
      `INSERT INTO ${this.s}.control (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`,
      key,
      JSON.stringify(value)
    );
    return rows.length === 1;
  }

  async setControl(key: string, value: unknown) {
    await this.db.$executeRawUnsafe(
      `INSERT INTO ${this.s}.control (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      key,
      JSON.stringify(value)
    );
  }

  async queueStats(): Promise<QueueStats> {
    const rows = await this.q(
      `SELECT
         count(*) FILTER (WHERE next_run_at IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at <= now()))::int AS runnable,
         count(*) FILTER (WHERE lease_expires_at > now())::int AS leased,
         count(*) FILTER (WHERE state IN ('waiting_user', 'awaiting_funding'))::int AS waiting,
         count(*)::int AS total
       FROM ${this.s}.tasks`
    );
    const r = rows[0];
    return { runnable: r.runnable, leased: r.leased, waiting: r.waiting, total: r.total };
  }
}
