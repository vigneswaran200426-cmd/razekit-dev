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
