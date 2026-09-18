import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { id, loadDb, transact } from "./store.js";

const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./
];

function hostnameAllowed(hostname, allowedHosts) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.length === 0 || allowedHosts.some(host =>
    normalized === host || normalized.endsWith("." + host)
  );
}

function isPrivateIp(hostname) {
  const family = isIP(hostname);
  if (family === 4) return PRIVATE_IPV4.some(pattern => pattern.test(hostname));
  if (family === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

export function assertNetworkAccess(policy, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new Error("Network target must be a valid URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Network policy only permits HTTP(S)");
  }

  if (policy.defaultAction === "deny") {
    const allowedHosts = policy.allowedHosts || [];
    if (!hostnameAllowed(url.hostname, allowedHosts)) {
      throw new Error("Network target is not allowed by policy");
    }
  }

  if (policy.denyPrivateNetworks !== false && isPrivateIp(url.hostname)) {
    throw new Error("Private or local network targets are denied");
  }

  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  const allowedPorts = policy.allowedPorts || [];
  if (allowedPorts.length > 0 && !allowedPorts.includes(port)) {
    throw new Error("Network port is not allowed by policy");
  }

  return {
    allowed: true,
    protocol: url.protocol,
    hostname: url.hostname,
    port
  };
}

export async function createNetworkPolicy({
  name,
  tenantId = "local-tenant",
  defaultAction = "deny",
  allowedHosts = [],
  allowedPorts = [80, 443],
  denyPrivateNetworks = true
} = {}) {
  if (!name?.trim()) throw new Error("Network policy name is required");
  if (!["allow", "deny"].includes(defaultAction)) throw new Error("defaultAction must be allow or deny");

  return transact(db => {
    const now = new Date().toISOString();
    const policy = {
      id: id("netpol"),
      tenantId,
      name,
      defaultAction,
      allowedHosts: [...new Set(allowedHosts.map(String))],
      allowedPorts: [...new Set(allowedPorts.map(Number).filter(Number.isFinite))],
      denyPrivateNetworks,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    db.networkPolicies.push(policy);
    return policy;
  });
}

export async function getNetworkPolicy(policyId) {
  const db = await loadDb();
  return db.networkPolicies.find(item => item.id === policyId) || null;
}


export async function assertResolvedNetworkAccess(policy, target) {
  const allowed = assertNetworkAccess(policy, target);
  const records = await lookup(allowed.hostname, { all: true });
  if (records.some(record => isPrivateIp(record.address))) {
    throw new Error("Resolved network target points to a private or local address");
  }
  return {
    ...allowed,
    resolvedAddresses: records.map(record => record.address)
  };
}
