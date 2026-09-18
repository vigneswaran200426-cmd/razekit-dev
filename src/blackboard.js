import { id, transact, loadDb } from "./store.js";

const MAX_ENTRY_CHARS = Number(process.env.RAZEKIT_BLACKBOARD_ENTRY_CHARS || 12000);

function normalizeValue(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (json.length <= MAX_ENTRY_CHARS) return value;
  return json.slice(0, MAX_ENTRY_CHARS);
}

export async function readBlackboard(agentInstanceId) {
  const db = await loadDb();
  return db.agentBlackboards.filter(x => x.agentInstanceId === agentInstanceId);
}

export async function writeBlackboard(agentInstanceId, key, value, source = "orchestrator") {
  if (!key?.trim()) throw new Error("Blackboard key is required");

  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");

    const normalized = normalizeValue(value);
    const now = new Date().toISOString();
    const existing = db.agentBlackboards.find(
      x => x.agentInstanceId === agentInstanceId && x.key === key
    );

    if (existing) {
      existing.value = normalized;
      existing.version += 1;
      existing.source = source;
      existing.updatedAt = now;
      return existing;
    }

    const entry = {
      id: id("bb"),
      agentInstanceId,
      key,
      value: normalized,
      version: 1,
      source,
      createdAt: now,
      updatedAt: now
    };

    db.agentBlackboards.push(entry);
    return entry;
  });
}

export async function snapshotBlackboard(agentInstanceId, reason = "context_compaction") {
  const entries = await readBlackboard(agentInstanceId);
  return {
    agentInstanceId,
    reason,
    createdAt: new Date().toISOString(),
    entries
  };
}
