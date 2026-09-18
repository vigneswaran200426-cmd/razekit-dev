import { id, transact, loadDb } from "./store.js";
import { createDefaultModelSessions } from "./orchestrator-domain.js";

export async function provisionModelSessions(agent) {
  const existing = await (async () => {
    const db = await loadDb();
    return db.modelSessions.filter(x => x.agentInstanceId === agent.id);
  })();

  if (existing.length > 0) return existing;

  const templates = createDefaultModelSessions(agent);

  return transact(db => {
    const duplicate = db.modelSessions.filter(x => x.agentInstanceId === agent.id);
    if (duplicate.length > 0) return duplicate;

    const now = new Date().toISOString();
    const sessions = templates.map(template => ({
      ...template,
      id: id("session"),
      state: "ready",
      contextVersion: 1,
      createdAt: now,
      updatedAt: now,
      lastError: null
    }));

    db.modelSessions.push(...sessions);
    return sessions;
  });
}

export async function listModelSessions(agentInstanceId) {
  const db = await loadDb();
  return db.modelSessions.filter(x => x.agentInstanceId === agentInstanceId);
}

export async function getModelSession(sessionId) {
  const db = await loadDb();
  const session = db.modelSessions.find(x => x.id === sessionId);
  if (!session) return null;

  return {
    ...session,
    messages: db.modelMessages.filter(x => x.sessionId === sessionId)
  };
}

export async function updateModelSession(sessionId, patch) {
  return transact(db => {
    const session = db.modelSessions.find(x => x.id === sessionId);
    if (!session) throw new Error("Model session not found");

    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    return session;
  });
}

export async function appendModelMessage(sessionId, role, content, metadata = {}) {
  if (!content?.trim()) throw new Error("Model message content is required");

  return transact(db => {
    const session = db.modelSessions.find(x => x.id === sessionId);
    if (!session) throw new Error("Model session not found");

    const message = {
      id: id("modelmsg"),
      sessionId,
      agentInstanceId: session.agentInstanceId,
      role,
      content: content.trim(),
      metadata,
      createdAt: new Date().toISOString()
    };

    db.modelMessages.push(message);
    return message;
  });
}

export async function recordModelUsage(sessionId, usage = {}) {
  const inputTokens = Math.max(0, Number(usage.inputTokens || 0));
  const outputTokens = Math.max(0, Number(usage.outputTokens || 0));
  const cost = Math.max(0, Number(usage.cost || 0));

  return transact(db => {
    const session = db.modelSessions.find(x => x.id === sessionId);
    if (!session) throw new Error("Model session not found");

    session.turns += 1;
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.cost += cost;
    session.updatedAt = new Date().toISOString();

    db.modelUsage.push({
      id: id("usage"),
      sessionId,
      agentInstanceId: session.agentInstanceId,
      inputTokens,
      outputTokens,
      cost,
      createdAt: new Date().toISOString()
    });

    return session;
  });
}
