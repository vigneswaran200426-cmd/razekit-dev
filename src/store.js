import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const DB_FILE = path.join(DATA_DIR, "db.json");

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
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

export function id(prefix) {
  return prefix + "_" + randomUUID();
}

export async function transact(mutator) {
  const db = await loadDb();
  const result = await mutator(db);
  await saveDb(db);
  return result;
}
