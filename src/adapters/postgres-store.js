import { randomUUID } from "node:crypto";

// The production persistence path.
//
// The JSON store kept all 42 collections in one file and serialised writes
// through a single in-process promise chain. That is correct in one process and
// silently wrong in two: two containers are two separate files, and the
// "atomic" job claim is only atomic inside the process that happens to run it.
// Nothing about that failure is loud — the second container simply works on its
// own private copy of reality.
//
// This backs the same three-function surface (loadDb / transact / id) with
// Postgres, so all 24 dependent modules are unchanged, and makes transact()
// genuinely atomic across processes.
//
// Three decisions worth stating:
//
//   The whole document is read per transaction, exactly as the JSON store read
//   the whole file — so this is a faithful port, not a rewrite that invents new
//   interleavings. It is one query, not 42. Only rows that actually changed are
//   written back, which is where the real saving is: a job claim reads once and
//   writes one row instead of rewriting the world.
//
//   The lock is transaction-scoped (pg_advisory_xact_lock), never session-
//   scoped. Neon's pooled endpoint is PgBouncer in transaction mode, where
//   session state does not survive between statements, so a session-level lock
//   would be released at an unpredictable moment and guard nothing.
//
//   The lock is global, reproducing the JSON store's single serialised queue.
//   Every invariant those 24 modules rely on held because writes were
//   serialised; they still are, now across containers. The queue is the one
//   genuine hot spot, so it gets its own non-serialised claim path below.

const LOCK_NAMESPACE = 0x727a6b74; // "rzkt"

const META_KEYS = new Set(["schemaVersion", "migrationsApplied"]);

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error("Unsafe SQL identifier: " + name);
  }
  return '"' + name + '"';
}

export class PostgresStore {
  /**
   * @param {object}   options
   * @param {string}   options.connectionString
   * @param {string}   options.schema           Postgres schema holding the tables.
   * @param {string[]} options.collections      Every known collection name.
   * @param {object}   options.initialState     Defaults for a fresh database.
   * @param {(db:object)=>object} options.migrate The same migration the JSON store runs.
   */
  constructor({ connectionString, schema = "razekit_dev", collections, initialState, migrate, pool = null }) {
    if (!connectionString) throw new Error("RAZEKIT_DATABASE_URL is required for the Postgres store");
    this.connectionString = connectionString;
    this.schema = schema;
    this.collections = collections.filter((name) => !META_KEYS.has(name));
    this.initialState = initialState;
    this.migrate = migrate || ((db) => db);
    this.pool = pool;
    this.state = quoteIdent(schema) + "." + quoteIdent("rk_state");
    this.meta = quoteIdent(schema) + "." + quoteIdent("rk_meta");
    this.lastWriteCount = 0;
  }

  async getPool() {
    if (this.pool) return this.pool;
    // Imported lazily so the JSON store — and therefore CI, which installs
    // nothing — never needs the driver to be present.
    const pg = await import("pg");
    const Pool = pg.default?.Pool || pg.Pool;
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: Number(process.env.RAZEKIT_DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: Number(process.env.RAZEKIT_DB_CONNECT_TIMEOUT_MS || 15_000),
    });
    return this.pool;
  }

  async end() {
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      await pool.end();
    }
  }

  async health() {
    const pool = await this.getPool();
    const r = await pool.query("SELECT 1 AS ok");
    return Number(r.rows?.[0]?.ok) === 1;
  }

  /** Reads every collection in one round trip, preserving insertion order. */
  async readAll(client) {
    const db = {};
    for (const name of this.collections) db[name] = [];

    const rows = await client.query(
      `SELECT collection, data FROM ${this.state} ORDER BY collection, ord`
    );
    for (const row of rows.rows) {
      if (!db[row.collection]) db[row.collection] = [];
      db[row.collection].push(row.data);
    }

    const meta = await client.query(`SELECT key, value FROM ${this.meta}`);
    const values = {};
    for (const row of meta.rows) values[row.key] = row.value;
    db.schemaVersion = values.schemaVersion ?? this.initialState.schemaVersion;
    db.migrationsApplied = values.migrationsApplied ?? [...this.initialState.migrationsApplied];

    return db;
  }

  /**
   * A full read-only snapshot, matching loadDb() in the JSON store.
   *
   * REPEATABLE READ so a reader never observes half of one writer's change —
   * something the JSON store got for free by reading a single file.
   */
  async loadDb() {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const db = await this.readAll(client);
      await client.query("COMMIT");
      return this.migrate(db);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Runs a mutator inside one Postgres transaction under the global lock.
   *
   * Returns whatever the mutator returns, like the JSON store. If the mutator
   * throws, the transaction rolls back and nothing is written — the JSON store
   * had the same property only because it never reached its save step.
   */
  async transact(mutator) {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_NAMESPACE]);

      const db = this.migrate(await this.readAll(client));

      // Snapshot before the mutator runs so in-place edits are detectable.
      // The modules routinely mutate rows they found (task.status = ...), so
      // comparing object identity would miss almost every real change.
      const before = new Map();
      for (const name of this.collections) {
        const rows = new Map();
        for (const row of db[name] || []) {
          if (row && typeof row === "object" && row.id) rows.set(row.id, JSON.stringify(row));
        }
        before.set(name, rows);
      }
      const metaBefore = JSON.stringify([db.schemaVersion, db.migrationsApplied]);

      const result = await mutator(db);

      let writes = 0;
      for (const name of this.collections) {
        const prior = before.get(name);
        const seen = new Set();

        for (const row of db[name] || []) {
          if (!row || typeof row !== "object") continue;
          if (!row.id) {
            throw new Error(
              `A row added to "${name}" has no id. The Postgres store keys every row by id.`
            );
          }
          seen.add(row.id);
          const serialised = JSON.stringify(row);
          if (prior.get(row.id) === serialised) continue;
          await client.query(
            `INSERT INTO ${this.state} (collection, id, data)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (collection, id)
             DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [name, row.id, serialised]
          );
          writes += 1;
        }

        for (const id of prior.keys()) {
          if (seen.has(id)) continue;
          await client.query(
            `DELETE FROM ${this.state} WHERE collection = $1 AND id = $2`,
            [name, id]
          );
          writes += 1;
        }
      }

      if (JSON.stringify([db.schemaVersion, db.migrationsApplied]) !== metaBefore) {
        for (const key of META_KEYS) {
          await client.query(
            `INSERT INTO ${this.meta} (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [key, JSON.stringify(db[key])]
          );
        }
      }

      await client.query("COMMIT");
      this.lastWriteCount = writes;
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Claims one runnable job without taking the global lock.
   *
   * This is the queue's hot path and the one place where serialising every
   * worker would actually hurt: N workers polling would take turns through a
   * single lock for work that is disjoint by definition. FOR UPDATE SKIP LOCKED
   * lets each worker take a different row concurrently, and the row lock — not
   * a read-then-write in application code — is what makes it exclusive.
   *
   * `now` is supplied by the caller and never taken from the database. Every
   * timestamp in a job — availableAt, leaseExpiresAt — is written by the
   * application, so comparing them against the database's now() puts two
   * different clocks in one comparison. The gap between this host and Neon
   * measured 154 seconds, which is enough to make a freshly scheduled retry
   * invisible until the database clock catches up, and enough to expire a lease
   * that has not expired. One clock per comparison, and it is the app's.
   *
   * Returns the claimed job row, or null when nothing is runnable.
   */
  async claimJob({ ownerId, leaseMs = 30_000, filters = {}, jobStatuses, runningStatus, now = new Date() }) {
    if (!ownerId?.trim()) throw new Error("Job lease owner is required");
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
      const conditions = [
        `collection = 'jobs'`,
        `data->>'status' = ANY($1)`,
        `(data->>'availableAt')::timestamptz <= $2::timestamptz`
      ];
      const params = [jobStatuses, nowIso];
      for (const [field, value] of Object.entries(filters)) {
        if (value == null) continue;
        params.push(value);
        conditions.push(`data->>${quoteLiteral(field)} = $${params.length}`);
      }

      const picked = await client.query(
        `SELECT id, data FROM ${this.state}
          WHERE ${conditions.join(" AND ")}
          ORDER BY (data->>'availableAt')::timestamptz, ord
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        params
      );

      if (picked.rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }

      const job = picked.rows[0].data;
      const claimedAt = Date.parse(nowIso);
      job.status = runningStatus;
      job.attempts = Number(job.attempts || 0) + 1;
      job.leaseId = randomUUID();
      job.leaseOwner = ownerId;
      job.leaseExpiresAt = new Date(claimedAt + Math.max(1000, leaseMs)).toISOString();
      job.updatedAt = nowIso;

      await client.query(
        `UPDATE ${this.state} SET data = $2::jsonb, updated_at = now()
          WHERE collection = 'jobs' AND id = $1`,
        [job.id, JSON.stringify(job)]
      );

      await client.query("COMMIT");
      return job;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Creates the meta rows a fresh database needs. */
  async bootstrap() {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.meta} (key, value)
       VALUES ('schemaVersion', $1::jsonb), ('migrationsApplied', $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [
        JSON.stringify(this.initialState.schemaVersion),
        JSON.stringify(this.initialState.migrationsApplied),
      ]
    );
  }
}

// Field names come from this codebase, never from a request, but they are still
// interpolated rather than bound — so they are quoted properly rather than
// trusted.
function quoteLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export function id(prefix) {
  return prefix + "_" + randomUUID();
}
