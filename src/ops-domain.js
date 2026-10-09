// The two 24/7 supervisory systems, the product agents they govern, and the
// rules for deciding what state any of them is really in.
//
// Nothing here talks to a process. Status is derived from evidence a process
// wrote (a heartbeat, a mode it applied) and the age of that evidence. A system
// that never wrote a heartbeat is "not configured"; one whose heartbeat has
// aged out is "offline", however healthy its last report looked.

export const SYSTEM_IDS = Object.freeze({ BUILDER: "builder", AUDITOR: "auditor" });

export const SYSTEMS = Object.freeze({
  builder: Object.freeze({
    id: "builder",
    code: "A",
    name: "RazeKit DEV Builder",
    purpose: "Develops the RazeKit DEV platform itself: inspects, plans, implements, tests, checkpoints and opens draft pull requests. Never merges or deploys."
  }),
  auditor: Object.freeze({
    id: "auditor",
    code: "B",
    name: "Runtime Operations and Auditor",
    purpose: "Monitors and diagnoses the running RazeKit DEV platform, performs authorized reversible repairs, and files engineering tasks for System A when code must change."
  })
});

// Separate principals for the inference gateway, the product agents and the
// admin, so every model call and every log line is attributable.
export const OPS_SOURCES = Object.freeze(["builder", "auditor", "gateway", "niomi", "konami", "admin"]);
export const PRODUCT_AGENT_IDS = Object.freeze(["niomi", "konami"]);

export const PRODUCT_AGENTS = Object.freeze({
  niomi: Object.freeze({
    id: "niomi",
    name: "Niomi",
    role: "Application and web development: app/web execution plans, Node/npm/Git builds, browser testing and deployment adapters.",
    taskTypes: ["app", "website"]
  }),
  konami: Object.freeze({
    id: "konami",
    name: "Konami",
    role: "Game development: engine-specific (Unity, Unreal, Godot) builds, asset pipeline, playtests and packaging.",
    taskTypes: ["game"]
  })
});

// System A is limited to these seven areas, each with the files it may change.
// A path outside the area — or on the deny list — is refused before a patch is
// applied, whatever the model proposed.
export const BUILDER_SCOPE_AREAS = Object.freeze({
  niomi: Object.freeze({
    label: "Niomi",
    paths: ["src/app-web-domain.js", "src/app-web-executor.js", "src/testing-app-web-adapters.js", "src/ops-browser.js", "test/app-web-executor.test.js", "test/ops-browser.test.js"]
  }),
  konami: Object.freeze({
    label: "Konami",
    paths: ["src/game-domain.js", "src/game-executor.js", "src/game-engine-adapters.js", "src/game-playtest-adapters.js", "src/game-artifacts.js", "src/testing-game-adapters.js", "test/game-executor.test.js", "test/game-engine-adapters.test.js", "test/konami-jev.test.js", "test/konami-loop-e2e.test.js"]
  }),
  "dev-backend": Object.freeze({
    label: "DEV Backend",
    paths: ["src/server.js", "src/dashboard.js", "src/agent-manager.js", "src/reliability.js", "src/observability.js", "src/production-runtime.js", "src/runtime-coordinator.js", "src/worker-agent.js", "src/worker-runtime.js", "src/verification.js", "test/**"]
  }),
  "dev-frontend": Object.freeze({
    label: "DEV Frontend",
    paths: ["src/dashboard-page.js", "src/login-page.js", "src/admin-ops-page.js", "test/dashboard-page.test.js", "test/admin-ops-page.test.js"]
  }),
  admin: Object.freeze({
    label: "Admin",
    paths: ["src/admin-ops-api.js", "src/admin-ops-page.js", "src/ops-state.js", "test/admin-ops-api.test.js", "test/admin-ops-page.test.js"]
  }),
  "ai-infrastructure": Object.freeze({
    label: "AI Infrastructure",
    paths: ["src/inference-gateway.js", "src/ollama-client.js", "src/model-context.js", "src/model-orchestrator.js", "src/model-sessions.js", "src/adapters/model-prompts.js", "src/adapters/model-json.js", "src/adapters/ollama-gateway-adapter.js", "test/inference-gateway.test.js", "test/model-context.test.js", "test/model-orchestrator.test.js"]
  }),
  "dev-workflows": Object.freeze({
    label: "DEV Workflows",
    paths: ["src/jev.js", "src/jev-domain.js", "src/jev-executor.js", "src/jev-planner.js", "src/jev-worker.js", "src/jev-model-graph.js", "src/jev-model-loop.js", "src/autonomous-loop.js", "src/task-lifecycle.js", "src/task-control.js", "src/task-instructions.js", "test/jev.test.js", "test/jev-planner.test.js", "test/autonomous-loop.test.js", "test/task-lifecycle.test.js"]
  })
});

// Never changed by System A, whatever the scope area says: identity, secrets,
// money, persistence, CI and infrastructure.
export const BUILDER_DENIED_PATHS = Object.freeze([
  ".github/**", "scripts/**", "self-build/**", "infra/**", "package.json", "package-lock.json",
  ".env", ".env.example", "src/auth.js", "src/admin-control.js", "src/credential-vault.js",
  "src/secret-vault.js", "src/permission-broker.js", "src/store.js", "src/adapters/postgres-store.js",
  "src/billing.js", "src/budget-manager.js", "src/jev-budget.js", "src/tenant-security.js",
  "src/gpu-controller.js", "src/ops-builder.js", "src/ops-auditor.js", "src/ops-supervisor.js", "src/ops-domain.js"
]);

function globMatch(file, pattern) {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

/** True only for a clean relative path inside the scope area and off the deny list. */
export function builderPathAllowed(file, scopeArea) {
  const area = BUILDER_SCOPE_AREAS[scopeArea];
  if (!area) return false;
  const value = String(file || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[a-zA-Z]:/.test(value) || value.includes("\0")) return false;
  if (value.split("/").some(part => part === "" || part === "." || part === "..")) return false;
  if (BUILDER_DENIED_PATHS.some(pattern => globMatch(value, pattern))) return false;
  return area.paths.some(pattern => globMatch(value, pattern));
}

// ── Models ──────────────────────────────────────────────────────────────────

export const MODEL_SLOTS = Object.freeze({ CODING: "coding", REASONING: "reasoning" });

export const DEFAULT_MODEL_ASSIGNMENTS = Object.freeze({
  coding: "qwen3-coder:30b",
  reasoning: "gpt-oss:20b"
});

// Supported local models. An assignment outside this list is refused; so is
// anything that names a hosted ("cloud") variant, because the approved
// assignment is local inference and must not be swapped for a cloud model.
export const DEFAULT_SUPPORTED_MODELS = Object.freeze(["qwen3-coder:30b", "gpt-oss:20b", "devstral-small-2:24b"]);

export function supportedModels(env = process.env) {
  const configured = String(env.RAZEKIT_SUPPORTED_MODELS || "").split(",").map(item => item.trim()).filter(Boolean);
  return configured.length ? configured : [...DEFAULT_SUPPORTED_MODELS];
}

export function validateModelId(model, env = process.env) {
  const value = String(model || "").trim();
  if (!/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(value)) throw new Error("Model ID is not a valid Ollama model reference");
  if (/(^|[:\-])cloud($|[:\-])/i.test(value)) throw new Error("Cloud-hosted model variants are not allowed for local slots");
  if (!supportedModels(env).includes(value)) {
    throw new Error("Model " + value + " is not in the supported list: " + supportedModels(env).join(", "));
  }
  return value;
}

export const DEFAULT_CONTEXT_TOKENS = 16384;

// ── Status ──────────────────────────────────────────────────────────────────

export const PROCESS_STATUS = Object.freeze({
  STARTING: "starting",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed"
});

export const DISPLAY_STATUS = Object.freeze({
  RUNNING: "running",
  STARTING: "starting",
  PAUSED: "paused",
  STOPPING: "stopping",
  FAILED: "failed",
  OFFLINE: "offline",
  STALE: "stale",
  NOT_CONFIGURED: "not_configured"
});

export function heartbeatThresholds(env = process.env) {
  const intervalMs = Math.max(1000, Number(env.RAZEKIT_OPS_HEARTBEAT_MS || 15000));
  return {
    intervalMs,
    staleAfterMs: Math.max(intervalMs * 3, Number(env.RAZEKIT_OPS_STALE_AFTER_MS || 0)),
    offlineAfterMs: Math.max(intervalMs * 8, Number(env.RAZEKIT_OPS_OFFLINE_AFTER_MS || 0))
  };
}

/**
 * The status a person should be shown for a supervised process.
 *
 * Only a fresh heartbeat can make something "running". An old heartbeat never
 * keeps reporting what it said last: it ages into "stale", then "offline".
 */
export function deriveProcessStatus(heartbeat, { now = Date.now(), thresholds = heartbeatThresholds() } = {}) {
  if (!heartbeat || !heartbeat.at) {
    return { status: DISPLAY_STATUS.NOT_CONFIGURED, ageMs: null, reason: "No process has ever reported a heartbeat" };
  }
  const at = Date.parse(heartbeat.at);
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : Infinity;
  if (heartbeat.status === PROCESS_STATUS.STOPPED) {
    return { status: DISPLAY_STATUS.OFFLINE, ageMs, reason: "Process reported a clean shutdown" };
  }
  if (ageMs > thresholds.offlineAfterMs) {
    return { status: DISPLAY_STATUS.OFFLINE, ageMs, reason: "Last heartbeat is older than " + Math.round(thresholds.offlineAfterMs / 1000) + "s" };
  }
  if (ageMs > thresholds.staleAfterMs) {
    return { status: DISPLAY_STATUS.STALE, ageMs, reason: "Heartbeat is late; the process may be hung or unreachable" };
  }
  const reported = Object.values(DISPLAY_STATUS).includes(heartbeat.status) ? heartbeat.status : DISPLAY_STATUS.FAILED;
  return { status: reported, ageMs, reason: heartbeat.statusReason || null };
}

// ── Tasks and controls ──────────────────────────────────────────────────────

export const TASK_STATUS = Object.freeze({
  QUEUED: "queued",
  LEASED: "leased",
  RUNNING: "running",
  WAITING_INFERENCE: "waiting_inference",
  WAITING_APPROVAL: "waiting_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  DEAD_LETTER: "dead_letter"
});

export const ACTIVE_TASK_STATUSES = Object.freeze([
  TASK_STATUS.QUEUED, TASK_STATUS.LEASED, TASK_STATUS.RUNNING, TASK_STATUS.WAITING_INFERENCE, TASK_STATUS.WAITING_APPROVAL
]);
export const TERMINAL_TASK_STATUSES = Object.freeze([
  TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.DEAD_LETTER
]);

export const SYSTEM_ACTIONS = Object.freeze(["start", "pause", "resume", "stop_task"]);
export const AGENT_ACTIONS = Object.freeze(["pause", "resume"]);
export const GATEWAY_ACTIONS = Object.freeze(["gpu_start", "gpu_stop"]);

// requested -> accepted -> completed | failed; or expired when nobody accepted it.
export const CONTROL_STATUS = Object.freeze({
  REQUESTED: "requested",
  ACCEPTED: "accepted",
  COMPLETED: "completed",
  FAILED: "failed",
  EXPIRED: "expired"
});

export function controlRequestTtlMs(env = process.env) {
  return Math.max(10_000, Number(env.RAZEKIT_OPS_CONTROL_TTL_MS || 10 * 60_000));
}

export function backoffMs(attempt, { baseMs = 5000, maxMs = 15 * 60_000 } = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(maxMs, baseMs * 2 ** (n - 1));
}

// ── Redaction ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  [/(postgres(?:ql)?:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[redacted]@"],
  [/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]"],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, "[redacted-groq-key]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-api-key]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-aws-key-id]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[redacted-slack-token]"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]"],
  [/((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|aws_secret_access_key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[redacted]"],
  [/(x-razekit-admin-token\s*[:=]\s*)\S+/gi, "$1[redacted]"]
];

// "token" alone is not enough: promptTokens and contextTokens are usage counts.
const SECRET_KEYS = /(password|secret|^token$|(access|refresh|auth|bearer|session|github|admin|bootstrap|api)[_-]?token|api[_-]?key|authorization|cookie|credential|private[_-]?key|connection[_-]?string|database[_-]?url)/i;

export function redactText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/** Redacts by key name and by value pattern, recursively. */
export function redactValue(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redactValue(child, depth + 1);
  }
  return out;
}
