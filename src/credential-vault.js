import { randomUUID } from "node:crypto";
import { id, loadDb, transact } from "./store.js";
import { writeAudit } from "./tenant-security.js";

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
    const task = db.tasks.find(item => item.id === agent.taskId);
    const reference = {
      id: id("cred"),
      agentInstanceId,
      taskId: agent.taskId,
      tenantId: task?.tenantId || "local-tenant",
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
  }).then(async result => {
    await writeAudit({
      tenantId: result.tenantId || "local-tenant",
      action: "credential.register",
      resourceType: "credential",
      resourceId: result.id,
      metadata: { provider: result.provider, kind: result.kind, scopes: result.scopes }
    });
    return result;
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
  }).then(async result => {
    await writeAudit({
      tenantId: result.tenantId || "local-tenant",
      action: "credential.revoke",
      resourceType: "credential",
      resourceId: result.id
    });
    return result;
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


export async function issueTemporaryCredential(agentInstanceId, credentialId, { scopes = [], ttlMs = 10 * 60_000 } = {}) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 60 * 60_000) {
    throw new Error("Credential lease TTL must be between 1ms and 1 hour");
  }

  return transact(db => {
    const credential = db.credentials.find(item =>
      item.id === credentialId &&
      item.agentInstanceId === agentInstanceId &&
      item.status === "active" &&
      (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
    );
    if (!credential) throw new Error("Credential reference is unavailable");

    const requested = [...new Set(scopes.filter(Boolean))];
    if (!requested.every(scope => credential.scopes.includes(scope))) {
      throw new Error("Credential scope exceeds granted credential scope");
    }

    const now = new Date();
    const lease = {
      id: id("clease"),
      credentialId: credential.id,
      agentInstanceId,
      taskId: credential.taskId,
      secretRef: credential.secretRef,
      scopes: requested,
      status: "active",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      revokedAt: null
    };
    db.secretLeases.push(lease);
    return sanitizeCredentialLease(lease);
  }).then(async result => {
    await writeAudit({
      tenantId: (await loadDb()).tasks.find(item => item.id === result.taskId)?.tenantId || "local-tenant",
      action: "credential.lease.issue",
      resourceType: "credential-lease",
      resourceId: result.id,
      metadata: { credentialId: result.credentialId, scopes: result.scopes, expiresAt: result.expiresAt }
    });
    return result;
  });
}

export async function revokeTemporaryCredential(leaseId) {
  return transact(db => {
    const lease = db.secretLeases.find(item => item.id === leaseId);
    if (!lease) throw new Error("Credential lease not found");
    lease.status = "revoked";
    lease.revokedAt = new Date().toISOString();
    return sanitizeCredentialLease(lease);
  });
}

export async function validateTemporaryCredential(agentInstanceId, leaseId, requiredScopes = []) {
  const db = await loadDb();
  const lease = db.secretLeases.find(item =>
    item.id === leaseId &&
    item.agentInstanceId === agentInstanceId &&
    item.status === "active"
  );
  if (!lease) return null;
  if (Date.parse(lease.expiresAt) <= Date.now()) return null;
  if (!requiredScopes.every(scope => lease.scopes.includes(scope))) return null;
  return sanitizeCredentialLease(lease);
}

export async function listCredentialLeases(agentInstanceId) {
  const db = await loadDb();
  return db.secretLeases
    .filter(item => item.agentInstanceId === agentInstanceId)
    .map(sanitizeCredentialLease);
}

function sanitizeCredentialLease(lease) {
  return {
    id: lease.id,
    credentialId: lease.credentialId,
    agentInstanceId: lease.agentInstanceId,
    taskId: lease.taskId,
    secretRef: lease.secretRef,
    scopes: [...lease.scopes],
    status: lease.status,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    revokedAt: lease.revokedAt
  };
}
