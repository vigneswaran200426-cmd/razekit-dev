import os from "node:os";
import { randomUUID } from "node:crypto";

// The process that runs ON a worker machine and offers it to the control plane.
//
// Deliberately a client, not a server: the worker dials out to RazeKit DEV and
// says what it is. Nothing in the platform stores a worker's address, so the
// first AWS box is just the first caller — replacing it, adding a second, or
// moving to a different provider is a deployment change, not a code change.
// A worker that stops calling stops receiving work on its own.
//
//   node src/worker-agent.js
//
// Configuration is entirely environment-driven; see .env.example.

const ENGINE_URL = (process.env.RAZEKIT_ENGINE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.RAZEKIT_ADMIN_TOKEN || "";
const POOL_NAME = process.env.RAZEKIT_WORKER_POOL || "cpu-default";
const RESOURCE_CLASS = process.env.RAZEKIT_WORKER_RESOURCE_CLASS || "cpu";
const RUNTIME_KIND = process.env.RAZEKIT_WORKER_RUNTIME || "container";
const POOL_CAPACITY = Number(process.env.RAZEKIT_WORKER_POOL_CAPACITY || 4);
const HEARTBEAT_MS = Number(process.env.RAZEKIT_WORKER_HEARTBEAT_MS || 30_000);

// A stable identity across restarts, so a worker that reboots rejoins as itself
// rather than accumulating ghost registrations. The hostname is the natural key
// on a cloud instance; the random suffix only applies when there isn't one.
const WORKER_ID = process.env.RAZEKIT_WORKER_ID || os.hostname() || "worker-" + randomUUID();

/**
 * What this machine can actually offer.
 *
 * Reported rather than configured: a worker that claims capacity it does not
 * have gets scheduled work it cannot finish, and the scheduler only learns
 * about it when the lease expires.
 */
export function describeHost() {
  const cpus = os.cpus();
  return {
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model?.trim() || "unknown",
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    // No IP address, no instance id, no account identifier: the control plane
    // needs none of them to schedule work, and recording them would turn the
    // worker table into an inventory of the operator's infrastructure.
    uptimeSeconds: Math.round(os.uptime())
  };
}

/** Which task runtimes this machine can honestly run. */
export function detectCapabilities() {
  const configured = String(process.env.RAZEKIT_WORKER_CAPABILITIES || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;

  // Node is present by definition — this agent is running on it. Everything
  // else has to be declared, because guessing wrong means claiming game builds
  // on a machine with no engine installed.
  return ["node", "npm", "git"];
}

async function call(path, body, { admin = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (admin) {
    if (!ADMIN_TOKEN) throw new Error("RAZEKIT_ADMIN_TOKEN is required for worker registration");
    headers["x-razekit-admin-token"] = ADMIN_TOKEN;
  }

  const response = await fetch(ENGINE_URL + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error || "Worker call failed with HTTP " + response.status);
  }
  return payload;
}

export async function registerWorker() {
  const pool = await call("/internal/infrastructure/pools", {
    name: POOL_NAME,
    resourceClass: RESOURCE_CLASS,
    runtime: RUNTIME_KIND,
    capacity: POOL_CAPACITY,
    metadata: { managedBy: "worker-agent" }
  }, { admin: true });

  const worker = await call("/internal/infrastructure/workers/register", {
    poolId: pool.id,
    workerId: WORKER_ID,
    runtime: RUNTIME_KIND,
    resourceClass: RESOURCE_CLASS,
    capabilities: detectCapabilities(),
    metadata: describeHost()
  }, { admin: true });

  return { pool, worker };
}

export async function heartbeat() {
  // Carries live host state, so the scheduler sees memory pressure rather than
  // the numbers from whenever this worker last booted.
  return call("/internal/infrastructure/workers/" + encodeURIComponent(WORKER_ID) + "/heartbeat", {
    freeMemoryBytes: os.freemem(),
    loadAverage: os.loadavg()[0],
    reportedAt: new Date().toISOString()
  });
}

export async function startWorkerAgent() {
  const { pool, worker } = await registerWorker();
  const host = describeHost();

  console.log(
    "RazeKit DEV worker registered\n" +
    "  worker   " + worker.workerId + "\n" +
    "  pool     " + pool.name + " (" + pool.resourceClass + "/" + pool.runtime + ", capacity " + pool.capacity + ")\n" +
    "  capacity " + host.cpuCount + " vCPU, " + Math.round(host.totalMemoryBytes / 1e9) + " GB\n" +
    "  engine   " + ENGINE_URL
  );

  const timer = setInterval(() => {
    heartbeat().catch(error => {
      // A failed heartbeat is not fatal here: the control plane will mark this
      // worker stale and stop assigning it work, which is the correct outcome
      // and needs no cooperation from a worker that may be partitioned.
      console.error("Heartbeat failed: " + (error.message || "unknown error"));
    });
  }, HEARTBEAT_MS);
  timer.unref?.();

  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return { pool, worker, stop };
}

// Only starts when run directly, so the exports above stay importable by tests.
if (process.argv[1] && process.argv[1].endsWith("worker-agent.js")) {
  startWorkerAgent().catch(error => {
    console.error("Worker agent failed to start: " + (error.message || error));
    process.exit(1);
  });
}
