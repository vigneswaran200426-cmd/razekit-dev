import { randomUUID } from "node:crypto";
import { id, loadDb, transact } from "./store.js";

const VAULT_TOKEN_PREFIX = "vaultref_";

function assertCredentialMeta(input) {
  if (!input || typeof input !== "object") throw new Error("Credential metadata is required");
  if (!input.provider?.trim()) throw new Error("Credential provider is required");
  if (!input.kind?.trim()) throw new Error("Credential kind is required");
}

export async function registerCredentialReference(agentInstanceId, input) {
  assertCredentialMeta(input);

  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");

    const now = new Date().toISOString();
    const reference = {
      id: id("cred"),
      agentInstanceId,
      taskId: agent.taskId,
      provider: input.provider,
      kind: input.kind,
      scopes: [...new Set(input.scopes || [])],
      secretRef: VAULT_TOKEN_PREFIX + randomUUID(),
      status: "active",
      createdAt: now,
      expiresAt: input.expiresAt || null,
      revokedAt: null
    };

    db.credentials.push(reference);

    const matchingRequests = db.credentialRequests.filter(request =>
      request.agentInstanceId === agentInstanceId &&
      request.provider === input.provider &&
      request.status === "pending" &&
      request.scopes.every(scope => reference.scopes.includes(scope))
    );

    for (const request of matchingRequests) {
      request.status = "fulfilled";
      request.credentialId = reference.id;
      request.updatedAt = now;
    }

    const pendingPermission = db.permissionRequests.some(request =>
      request.agentInstanceId === agentInstanceId && request.status === "pending"
    );
    const pendingCredential = db.credentialRequests.some(request =>
      request.agentInstanceId === agentInstanceId && request.status === "pending"
    );

    if (!pendingPermission && !pendingCredential && agent.status === "waiting_user") {
      agent.status = "running";
      agent.executionState = "running";
      const task = db.tasks.find(x => x.id === agent.taskId);
      if (task?.status === "waiting_user") {
        task.status = "running";
        task.updatedAt = now;
      }
    }

    return sanitizeCredential(reference);
  });
}

export async function listCredentialReferences(agentInstanceId) {
  const db = await loadDb();
  return db.credentials
    .filter(x => x.agentInstanceId === agentInstanceId)
    .map(sanitizeCredential);
}

export async function revokeCredentialReference(credentialId) {
  return transact(db => {
    const credential = db.credentials.find(x => x.id === credentialId);
    if (!credential) throw new Error("Credential reference not found");

    credential.status = "revoked";
    credential.revokedAt = new Date().toISOString();
    return sanitizeCredential(credential);
  });
}

export function sanitizeCredential(credential) {
  return {
    id: credential.id,
    agentInstanceId: credential.agentInstanceId,
    taskId: credential.taskId,
    provider: credential.provider,
    kind: credential.kind,
    scopes: [...credential.scopes],
    secretRef: credential.secretRef,
    status: credential.status,
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt
  };
}

export async function resolveCredentialReference(agentInstanceId, provider, requiredScopes = []) {
  const db = await loadDb();
  const candidates = db.credentials.filter(x =>
    x.agentInstanceId === agentInstanceId &&
    x.provider === provider &&
    x.status === "active" &&
    (!x.expiresAt || Date.parse(x.expiresAt) > Date.now())
  );

  const scopeSet = new Set(requiredScopes);
  const match = candidates.find(x => requiredScopes.every(scope => new Set(x.scopes).has(scope)));
  if (!match) return null;
  return sanitizeCredential(match);
}

export async function requestCredentialReference(agentInstanceId, provider, scopes = [], reason = "Credential required for tool execution") {
  if (!provider?.trim()) throw new Error("Credential provider is required");
  const normalizedScopes = [...new Set(scopes.filter(Boolean))];

  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");

    const existing = db.credentialRequests.find(x =>
      x.agentInstanceId === agentInstanceId &&
      x.provider === provider &&
      x.status === "pending" &&
      JSON.stringify(x.scopes) === JSON.stringify(normalizedScopes)
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const request = {
      id: id("creq"),
      agentInstanceId,
      taskId: agent.taskId,
      provider,
      scopes: normalizedScopes,
      reason,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };

    const task = db.tasks.find(x => x.id === agent.taskId);
    agent.status = "waiting_user";
    agent.executionState = "waiting_user";
    if (task) {
      task.status = "waiting_user";
      task.updatedAt = now;
    }

    db.credentialRequests.push(request);
    return request;
  });
}

export async function listCredentialRequests(agentInstanceId) {
  const db = await loadDb();
  return db.credentialRequests.filter(x => x.agentInstanceId === agentInstanceId && x.status === "pending");
}
