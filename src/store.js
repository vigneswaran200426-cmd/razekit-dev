import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// State for the whole engine, behind three functions: loadDb, transact, id.
//
// Two backings exist and the choice is explicit, never inferred:
//
//   json      A single file, writes serialised through one in-process promise
//             chain. Correct in one process, and ONLY in one process — two
//             containers would each get their own private file and neither
//             would know. Local development and CI, never production.
//
//   postgres  The production source of truth. Same three functions, genuinely
//             atomic across processes. See adapters/postgres-store.js.
//
// RAZEKIT_STORE selects. It defaults to json so a developer who runs the engine
// with no configuration gets the local path rather than an error — but
// assertProductionStore() below exists so a deployment cannot start on the
// local one by accident, which is the failure that actually matters.

const DATA_DIR = path.resolve(process.env.RAZEKIT_DATA_DIR || "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
let transactionQueue = Promise.resolve();

const SCHEMA_VERSION = 5;

const initialState = {
  schemaVersion: SCHEMA_VERSION,
  migrationsApplied: ["initial"],
  tasks: [],
  taskFiles: [],
  acceptanceCriteria: [],
  agentInstances: [],
  workspaces: [],
  workers: [],
  agentMessages: [],
  modelSessions: [],
  modelMessages: [],
  modelUsage: [],
  agentBlackboards: [],
  contextSnapshots: [],
  orchestrationRuns: [],
  toolPermissions: [],
  permissionRequests: [],
  credentials: [],
  credentialRequests: [],
  toolCalls: [],
  stateCheckpoints: [],
  jobs: [],
  idempotencyRecords: [],
  recoveryEvents: [],
  executionRuns: [],
  verificationRuns: [],
  taskChangeRequests: [],
  userUpdates: [],
  tenants: [],
  auditLogs: [],
  billingLedger: [],
  billingReservations: [],
  abuseCounters: [],
  adminActions: [],
  secretLeases: [],
  workerPools: [],
  productionWorkers: [],
  artifactObjects: [],
  networkPolicies: [],
  observabilityEvents: [],
  metrics: [],
  alerts: []
};

export const COLLECTIONS = Object.keys(initialState);
export const INITIAL_STATE = initialState;

export function migrateState(raw) {
  const db = raw && typeof raw === "object" ? raw : {};
  if (!Array.isArray(db.migrationsApplied)) db.migrationsApplied = ["initial"];
  for (const [key, value] of Object.entries(initialState)) {
    if (key === "schemaVersion" || key === "migrationsApplied") continue;
    if (!Array.isArray(db[key])) db[key] = [...value];
  }
  if (!db.migrationsApplied.includes("phase-6-reliability")) {
    db.migrationsApplied.push("phase-6-reliability");
  }
  if (!db.migrationsApplied.includes("phase-10-dashboard")) {
    db.migrationsApplied.push("phase-10-dashboard");
  }
  if (!db.migrationsApplied.includes("phase-11-security-billing")) {
    db.migrationsApplied.push("phase-11-security-billing");
  }
  if (!db.migrationsApplied.includes("phase-12-production-infrastructure")) {
    db.migrationsApplied.push("phase-12-production-infrastructure");
  }
  for (const task of db.tasks) {
    if (!task.tenantId) task.tenantId = "local-tenant";
    if (!task.userId) task.userId = "local-user";
  }
  for (const agent of db.agentInstances) {
    if (!agent.tenantId) {
      agent.tenantId = db.tasks.find(task => task.id === agent.taskId)?.tenantId || "local-tenant";
    }
  }
  for (const credential of db.credentials) {
    if (!credential.tenantId) {
      credential.tenantId = db.tasks.find(task => task.id === credential.taskId)?.tenantId || "local-tenant";
    }
  }
  for (const job of db.jobs) {
    if (!job.resourceClass) job.resourceClass = "cpu";
  }
  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

// ── Backend selection ────────────────────────────────────────────────────────

export const STORE_KIND = {
  JSON: "json",
  POSTGRES: "postgres"
};

let backend = null;

function selectedKind() {
  const kind = String(process.env.RAZEKIT_STORE || STORE_KIND.JSON).toLowerCase();
  if (!Object.values(STORE_KIND).includes(kind)) {
    throw new Error("RAZEKIT_STORE must be one of: " + Object.values(STORE_KIND).join(", "));
  }
  return kind;
}

export function storeKind() {
  return selectedKind();
}

/**
 * Refuses to run production on the local file store.
 *
 * Called by the server at startup. The JSON store does not fail loudly when a
 * second container appears — it just quietly serves a different reality — so
 * the only place that failure can be caught is before it starts.
 */
export function assertProductionStore() {
  if (selectedKind() !== STORE_KIND.POSTGRES) {
    throw new Error(
      "RAZEKIT_STORE=json cannot be used in production: the file store is process-local, " +
      "so every container would keep its own private copy of state. Set RAZEKIT_STORE=postgres."
    );
  }
}

async function getBackend() {
  if (backend) return backend;
  if (selectedKind() === STORE_KIND.POSTGRES) {
    const { PostgresStore } = await import("./adapters/postgres-store.js");
    const store = new PostgresStore({
      connectionString: process.env.RAZEKIT_DATABASE_URL,
      schema: process.env.RAZEKIT_DATABASE_SCHEMA || "razekit_dev",
      collections: COLLECTIONS,
      initialState,
      migrate: migrateState
    });
    await store.bootstrap();
    backend = store;
  } else {
    backend = null; // the JSON path below
  }
  return backend;
}

/** Test seam: point the store at an already-constructed backend. */
export function __setBackend(store) {
  backend = store;
}

/** Releases pooled connections. */
export async function closeStore() {
  if (backend?.end) await backend.end();
  backend = null;
}

// ── JSON backing ─────────────────────────────────────────────────────────────

async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(DB_FILE, "utf8");
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialState, null, 2));
  }
}

async function loadJson() {
  await ensureDb();
  return migrateState(JSON.parse(await readFile(DB_FILE, "utf8")));
}

export async function saveDb(db) {
  if (selectedKind() === STORE_KIND.POSTGRES) {
    throw new Error("saveDb() is a JSON-store operation; the Postgres store writes inside transact()");
  }
  await ensureDb();
  const migrated = migrateState(db);
  const tempFile = DB_FILE + ".tmp";
  await writeFile(tempFile, JSON.stringify(migrated, null, 2));
  await rename(tempFile, DB_FILE);
}

// ── Public surface ───────────────────────────────────────────────────────────

export async function loadDb() {
  const store = await getBackend();
  if (store) return store.loadDb();
  return loadJson();
}

export function id(prefix) {
  return prefix + "_" + randomUUID();
}

export function transact(mutator) {
  if (selectedKind() === STORE_KIND.POSTGRES) {
    return getBackend().then(store => store.transact(mutator));
  }

  const run = transactionQueue.then(async () => {
    const db = await loadJson();
    const result = await mutator(db);
    await saveDb(db);
    return result;
  });
  transactionQueue = run.catch(() => undefined);
  return run;
}

/**
 * The backing store, when one needs a capability the document model cannot
 * express — currently only the queue's row-level job claim.
 *
 * Returns null on the JSON store, and callers fall back to the in-document
 * path, which is what keeps local development and CI working unchanged.
 */
export async function nativeStore() {
  return getBackend();
}
