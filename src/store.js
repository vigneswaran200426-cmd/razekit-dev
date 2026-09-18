import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(process.env.RAZEKIT_DATA_DIR || "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
let transactionQueue = Promise.resolve();

const SCHEMA_VERSION = 4;

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
  secretLeases: []
};

function migrateState(raw) {
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
  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(DB_FILE, "utf8");
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialState, null, 2));
  }
}

export async function loadDb() {
  await ensureDb();
  return migrateState(JSON.parse(await readFile(DB_FILE, "utf8")));
}

export async function saveDb(db) {
  await ensureDb();
  const migrated = migrateState(db);
  const tempFile = DB_FILE + ".tmp";
  await writeFile(tempFile, JSON.stringify(migrated, null, 2));
  await rename(tempFile, DB_FILE);
}

export function id(prefix) {
  return prefix + "_" + randomUUID();
}

export function transact(mutator) {
  const run = transactionQueue.then(async () => {
    const db = await loadDb();
    const result = await mutator(db);
    await saveDb(db);
    return result;
  });
  transactionQueue = run.catch(() => undefined);
  return run;
}
