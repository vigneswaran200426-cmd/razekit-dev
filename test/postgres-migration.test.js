import { strict as assert } from "node:assert";
import test from "node:test";

// The state-table migration (PostgresStore.ensureSchema), against a real
// database. Skipped without RAZEKIT_DATABASE_URL, announced rather than silent.
// It works in a schema of its own that it drops afterwards, so it never touches
// the schema other tests or a real deployment use.

const DATABASE_URL = process.env.RAZEKIT_DATABASE_URL;

if (!DATABASE_URL) {
  test("postgres migration", { skip: "RAZEKIT_DATABASE_URL is not set" }, () => {});
}

const { PostgresStore } = await import("../src/adapters/postgres-store.js");
const { COLLECTIONS, INITIAL_STATE, migrateState } = await import("../src/store.js");

const suite = DATABASE_URL ? test : test.skip;
const SCHEMA = "rk_mig_" + Math.random().toString(36).slice(2, 10);

function makeStore() {
  return new PostgresStore({
    connectionString: DATABASE_URL,
    schema: SCHEMA,
    collections: COLLECTIONS,
    initialState: INITIAL_STATE,
    migrate: migrateState
  });
}

const EXPECTED_INDEXES = [
  "rk_meta_pkey",
  "rk_state_agent",
  "rk_state_collection_ord",
  "rk_state_jobs_claimable",
  "rk_state_jobs_idempotency",
  "rk_state_pkey",
  "rk_state_task",
  "rk_state_tenant"
];

suite("an empty database gets the schema, tables, sequence and every index", async () => {
  const store = makeStore();
  try {
    await store.bootstrap();
    const pool = await store.getPool();
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1", [SCHEMA]);
    assert.deepEqual(tables.rows.map(r => r.table_name), ["rk_meta", "rk_state"]);
    const indexes = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY 1", [SCHEMA]);
    assert.deepEqual(indexes.rows.map(r => r.indexname), EXPECTED_INDEXES);
    const meta = await pool.query(`SELECT value FROM ${SCHEMA}.rk_meta WHERE key = 'schemaVersion'`);
    assert.equal(meta.rows[0].value, INITIAL_STATE.schemaVersion);
    const seq = await pool.query("SELECT 1 FROM pg_class WHERE relname = 'rk_state_ord_seq' AND relnamespace = $1::regnamespace", [SCHEMA]);
    assert.equal(seq.rowCount, 1);
  } finally {
    await store.end();
  }
});

suite("running it again changes nothing and loses nothing", async () => {
  const first = makeStore();
  try {
    await first.transact(db => { db.tenants.push({ id: "keep-me", status: "active" }); });
  } finally {
    await first.end();
  }
  const second = makeStore();
  try {
    await second.bootstrap();
    await second.bootstrap();
    const db = await second.loadDb();
    assert.ok(db.tenants.some(t => t.id === "keep-me"), "existing rows survive a repeated migration");
  } finally {
    await second.end();
  }
});

suite("several containers starting at once on an empty database all succeed", async () => {
  const racing = "rk_race_" + Math.random().toString(36).slice(2, 10);
  const stores = Array.from({ length: 5 }, () => new PostgresStore({
    connectionString: DATABASE_URL, schema: racing, collections: COLLECTIONS, initialState: INITIAL_STATE, migrate: migrateState
  }));
  try {
    await Promise.all(stores.map(store => store.bootstrap()));
    const pool = await stores[0].getPool();
    const tables = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [racing]);
    assert.equal(tables.rows[0].n, 2);
    await pool.query(`DROP SCHEMA ${racing} CASCADE`);
  } finally {
    await Promise.all(stores.map(store => store.end()));
  }
});

test.after(async () => {
  if (!DATABASE_URL) return;
  const store = makeStore();
  try {
    const pool = await store.getPool();
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    await store.end();
  }
});
