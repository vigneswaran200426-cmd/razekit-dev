import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const DB_FILE = path.join(DATA_DIR, "db.json");
let transactionQueue = Promise.resolve();

const initialState = {
  tasks: [],
  taskFiles: [],
  acceptanceCriteria: [],
  agentInstances: [],
  workspaces: [],
  workers: [],
  agentMessages: []
};

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
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

export async function saveDb(db) {
  await ensureDb();
  const tempFile = DB_FILE + ".tmp";
  await writeFile(tempFile, JSON.stringify(db, null, 2));
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
