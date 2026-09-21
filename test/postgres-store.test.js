import { strict as assert } from "node:assert";
import test from "node:test";

// The Postgres store, verified against a real database.
//
// These tests are the reason the store was ported at all, so they are written
// to fail on the JSON store: every one of them uses SEPARATE store instances
// with SEPARATE connection pools, which is the closest thing in one process to
// two Fargate containers. A store that is only correct within one process
// passes none of the concurrency tests below.
//
// Skipped when RAZEKIT_DATABASE_URL is absent, so CI without a database stays
// green — but skipping is announced, never silent.

const DATABASE_URL = process.env.RAZEKIT_DATABASE_URL;
const SCHEMA = process.env.RAZEKIT_DATABASE_SCHEMA || "razekit_dev";

if (!DATABASE_URL) {
  test("postgres store", { skip: "RAZEKIT_DATABASE_URL is not set" }, () => {});
}

const { PostgresStore } = await import("../src/adapters/postgres-store.js");
const { COLLECTIONS, INITIAL_STATE, migrateState } = await import("../src/store.js");

const suite = DATABASE_URL ? test : test.skip;

function makeStore() {
  return new PostgresStore({
    connectionString: DATABASE_URL,
    schema: SCHEMA,
    collections: COLLECTIONS,
    initialState: INITIAL_STATE,
    migrate: migrateState,
  });
}

/** A unique marker so parallel runs and leftovers never collide. */
function marker() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function cleanup(store, tag) {
  const pool = await store.getPool();
  await pool.query(
    `DELETE FROM ${SCHEMA}.rk_state WHERE data->>'testTag' = $1`,
    [tag]
  );
}

suite("the database is reachable and the schema is in place", async () => {
  const store = makeStore();
  try {
    assert.equal(await store.health(), true, "SELECT 1 should succeed");

    const pool = await store.getPool();
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [SCHEMA]
    );
    const names = tables.rows.map((r) => r.table_name);
    assert.ok(names.includes("rk_state"), "rk_state must exist, got: " + names.join(", "));
    assert.ok(names.includes("rk_meta"), "rk_meta must exist, got: " + names.join(", "));
  } finally {
    await store.end();
  }
});

suite("a write through transact is durable and readable by a different connection", async () => {
  const writer = makeStore();
  const reader = makeStore();
  const tag = marker();
  try {
    const created = await writer.transact((db) => {
      const row = { id: "task_" + tag, testTag: tag, title: "durable", status: "queued" };
      db.tasks.push(row);
      return row;
    });

    // A completely separate pool — nothing is shared in memory.
    const db = await reader.loadDb();
    const found = db.tasks.find((t) => t.id === created.id);
    assert.ok(found, "a second connection must see the committed row");
    assert.equal(found.title, "durable");
  } finally {
    await cleanup(writer, tag);
    await writer.end();
    await reader.end();
  }
});

suite("an in-place edit to a loaded row is persisted", async () => {
  const store = makeStore();
  const tag = marker();
  try {
    await store.transact((db) => {
      db.tasks.push({ id: "task_" + tag, testTag: tag, status: "queued" });
    });

    // The modules edit rows they found rather than replacing them, so this is
    // the mutation shape that actually matters.
    await store.transact((db) => {
      const row = db.tasks.find((t) => t.id === "task_" + tag);
      row.status = "running";
    });

    const db = await store.loadDb();
    assert.equal(db.tasks.find((t) => t.id === "task_" + tag).status, "running");
  } finally {
    await cleanup(store, tag);
    await store.end();
  }
});

suite("a removed row is deleted, not orphaned", async () => {
  const store = makeStore();
  const tag = marker();
  try {
    await store.transact((db) => {
      db.tasks.push({ id: "task_" + tag, testTag: tag });
    });
    await store.transact((db) => {
      const i = db.tasks.findIndex((t) => t.id === "task_" + tag);
      db.tasks.splice(i, 1);
    });

    const db = await store.loadDb();
    assert.equal(db.tasks.find((t) => t.id === "task_" + tag), undefined);
  } finally {
    await cleanup(store, tag);
    await store.end();
  }
});

suite("a throwing mutator writes nothing", async () => {
  const store = makeStore();
  const tag = marker();
  try {
    await assert.rejects(
      () =>
        store.transact((db) => {
          db.tasks.push({ id: "task_" + tag, testTag: tag });
          throw new Error("deliberate failure");
        }),
      /deliberate failure/
    );

    const db = await store.loadDb();
    assert.equal(
      db.tasks.find((t) => t.id === "task_" + tag),
      undefined,
      "a rolled-back transaction must leave no row behind"
    );
  } finally {
    await cleanup(store, tag);
    await store.end();
  }
});

suite("concurrent writers from separate connections do not lose updates", async () => {
  // The test that justifies the whole port. Sixteen read-modify-write cycles
  // run concurrently across eight independent pools. Without a lock that spans
  // processes these interleave and the counter lands below 16 — which is
  // exactly what two Fargate containers would have done to every budget,
  // lease and attempt count in the system.
  const WRITERS = 8;
  const PER_WRITER = 2;
  const stores = Array.from({ length: WRITERS }, makeStore);
  const tag = marker();

  try {
    await stores[0].transact((db) => {
      db.tasks.push({ id: "task_" + tag, testTag: tag, counter: 0 });
    });

    await Promise.all(
      stores.flatMap((store) =>
        Array.from({ length: PER_WRITER }, () =>
          store.transact((db) => {
            const row = db.tasks.find((t) => t.id === "task_" + tag);
            row.counter = Number(row.counter) + 1;
          })
        )
      )
    );

    const db = await stores[0].loadDb();
    const final = db.tasks.find((t) => t.id === "task_" + tag);
    assert.equal(
      Number(final.counter),
      WRITERS * PER_WRITER,
      `expected ${WRITERS * PER_WRITER} increments, got ${final.counter} — updates were lost`
    );
  } finally {
    await cleanup(stores[0], tag);
    await Promise.all(stores.map((s) => s.end()));
  }
});

suite("two workers never claim the same job", async () => {
  // FOR UPDATE SKIP LOCKED, exercised the way the worker pool will: several
  // independent claimants racing for a shared queue. A job handed to two
  // workers means the same build runs twice in two workspaces.
  const JOBS = 12;
  const WORKERS = 6;
  const stores = Array.from({ length: WORKERS }, makeStore);
  const tag = marker();

  try {
    await stores[0].transact((db) => {
      for (let i = 0; i < JOBS; i += 1) {
        db.jobs.push({
          id: `job_${tag}_${i}`,
          testTag: tag,
          status: "queued",
          attempts: 0,
          availableAt: new Date(Date.now() - 1000).toISOString(),
          agentInstanceId: "agent_" + tag,
          resourceClass: "cpu",
          kind: "test",
        });
      }
    });

    const claimed = await Promise.all(
      stores.flatMap((store, w) =>
        Array.from({ length: Math.ceil(JOBS / WORKERS) + 1 }, () =>
          store.claimJob({
            ownerId: "worker-" + w,
            leaseMs: 30_000,
            filters: { kind: "test", agentInstanceId: "agent_" + tag },
            jobStatuses: ["queued", "retrying"],
            runningStatus: "running",
          })
        )
      )
    );

    const got = claimed.filter(Boolean);
    const ids = got.map((j) => j.id);
    assert.equal(new Set(ids).size, ids.length, "a job was claimed twice: " + ids.join(", "));
    assert.equal(ids.length, JOBS, `expected all ${JOBS} jobs claimed exactly once, got ${ids.length}`);

    // Every claim carries a distinct lease and a real owner.
    assert.equal(new Set(got.map((j) => j.leaseId)).size, JOBS);
    assert.ok(got.every((j) => j.status === "running" && j.attempts === 1 && j.leaseOwner));
  } finally {
    await cleanup(stores[0], tag);
    await Promise.all(stores.map((s) => s.end()));
  }
});

suite("the database refuses a duplicate idempotency key", async () => {
  // createJob deduped with an in-memory check-then-insert. Across containers
  // that is a race, so the guarantee is enforced by a unique index now.
  const a = makeStore();
  const b = makeStore();
  const tag = marker();
  try {
    await a.transact((db) => {
      db.jobs.push({
        id: "job_" + tag + "_1",
        testTag: tag,
        agentInstanceId: "agent_" + tag,
        idempotencyKey: "key_" + tag,
        status: "queued",
        availableAt: new Date().toISOString(),
      });
    });

    await assert.rejects(
      () =>
        b.transact((db) => {
          db.jobs.push({
            id: "job_" + tag + "_2",
            testTag: tag,
            agentInstanceId: "agent_" + tag,
            idempotencyKey: "key_" + tag,
            status: "queued",
            availableAt: new Date().toISOString(),
          });
        }),
      (e) => /duplicate key|unique/i.test(e.message),
      "a second job with the same idempotency key must be rejected by the database"
    );
  } finally {
    await cleanup(a, tag);
    await a.end();
    await b.end();
  }
});

suite("tenant scoping survives the round trip", async () => {
  const store = makeStore();
  const tag = marker();
  try {
    await store.transact((db) => {
      db.tasks.push({ id: "task_" + tag + "_a", testTag: tag, tenantId: "tenant-a", userId: "u1" });
      db.tasks.push({ id: "task_" + tag + "_b", testTag: tag, tenantId: "tenant-b", userId: "u2" });
    });

    const db = await store.loadDb();
    const mine = db.tasks.filter((t) => t.testTag === tag && t.tenantId === "tenant-a");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].userId, "u1");
  } finally {
    await cleanup(store, tag);
    await store.end();
  }
});

suite("insertion order is preserved across reload", async () => {
  // Several modules take the first match from a collection, so ordering is
  // behaviour, not presentation.
  const store = makeStore();
  const tag = marker();
  try {
    await store.transact((db) => {
      for (let i = 0; i < 5; i += 1) {
        db.agentMessages.push({ id: `msg_${tag}_${i}`, testTag: tag, seq: i });
      }
    });

    const db = await store.loadDb();
    const seqs = db.agentMessages.filter((m) => m.testTag === tag).map((m) => m.seq);
    assert.deepEqual(seqs, [0, 1, 2, 3, 4]);
  } finally {
    await cleanup(store, tag);
    await store.end();
  }
});
