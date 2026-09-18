export const TASK_TYPES = new Set(["app", "website", "game"]);

export const TASK_STATUS = {
  DRAFT: "draft",
  ANALYZING: "analyzing",
  AWAITING_BUDGET: "awaiting_budget",
  AUTHORIZED: "authorized",
  QUEUED: "queued",
  READY_FOR_AGENT: "ready_for_agent",
  RUNNING: "running",
  WAITING_USER: "waiting_user",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  PAUSED: "paused"
};

export const AGENT_TYPES = { NIOMI: "niomi", KONAMI: "konami" };

export const AGENT_STATUS = {
  PROVISIONING: "provisioning",
  READY: "ready",
  RUNNING: "running",
  WAITING_USER: "waiting_user",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  STOPPED: "stopped"
};

export const WORKER_STATUS = {
  PROVISIONING: "provisioning",
  READY: "ready",
  RUNNING: "running",
  STOPPED: "stopped",
  FAILED: "failed"
};

export function agentTypeForTask(taskType) {
  if (taskType === "game") return AGENT_TYPES.KONAMI;
  if (taskType === "app" || taskType === "website") return AGENT_TYPES.NIOMI;
  throw new Error("Unsupported task type: " + taskType);
}

const BASE_TOOLS = [
  { key: "filesystem", name: "Isolated Filesystem", scopes: ["read", "write"] },
  { key: "shell", name: "Sandboxed Shell", scopes: ["execute"] },
  { key: "git", name: "Git", scopes: ["read", "write"] }
];

const WEB_TOOLS = [
  { key: "browser", name: "Browser Automation", scopes: ["navigate", "inspect", "test"] },
  { key: "node", name: "Node.js", scopes: ["execute"] },
  { key: "python", name: "Python", scopes: ["execute"] },
  { key: "database", name: "Database Adapter", scopes: ["read", "write"] },
  { key: "deploy-web", name: "Web Deployment Adapter", scopes: ["deploy"] }
];

const GAME_TOOLS = [
  { key: "engine", name: "Game Engine Adapter", scopes: ["read", "write", "build"] },
  { key: "assets", name: "Asset Workspace", scopes: ["read", "write"] },
  { key: "game-playtest", name: "Automated Game Playtest", scopes: ["run", "inspect"] },
  { key: "game-build", name: "Game Build Adapter", scopes: ["build", "package"] }
];

export function toolManifestForTask(taskType, requestedTools = []) {
  const catalog = [...BASE_TOOLS, ...(taskType === "game" ? GAME_TOOLS : WEB_TOOLS)];
  const requestedSet = new Set(requestedTools);
  return catalog.map(tool => ({
    ...tool,
    enabled: requestedSet.size === 0 || requestedSet.has(tool.key)
  }));
}

export function buildPreflight(task) {
  const text = ((task.title || "") + " " + (task.originalRequest || "") + " " + (task.specification || "")).toLowerCase();
  const complexity = text.length > 4000 ? "high" : text.length > 1600 ? "medium" : "low";
  const budgetByType = {
    app: { low: 10, medium: 30, high: 75 },
    website: { low: 8, medium: 25, high: 60 },
    game: { low: 25, medium: 75, high: 180 }
  };
  const externalServices = [];
  if (/database|auth|login|signup|supabase|postgres|mysql|neon/.test(text)) externalServices.push("database/auth");
  if (/payment|razorpay|stripe|cashfree|checkout/.test(text)) externalServices.push("payment provider");
  if (/email|otp|mail/.test(text)) externalServices.push("email/OTP provider");
  if (/deploy|hosting|render|cloudflare|vercel/.test(text)) externalServices.push("hosting/deployment");
  if (task.taskType === "game") externalServices.push("game engine/build environment");

  return {
    complexity,
    estimatedBudget: budgetByType[task.taskType][complexity],
    currency: "USD",
    predictedAgentType: agentTypeForTask(task.taskType),
    predictedTools: task.taskType === "game"
      ? ["filesystem", "shell", "git", "engine", "assets", "game-playtest", "game-build"]
      : ["filesystem", "shell", "git", "browser", "node", "python", "database", "deploy-web"],
    externalServices,
    authorizationScopes: [
      "autonomous task execution",
      "workspace read/write",
      "sandboxed command execution",
      "git repository operations",
      "automated testing",
      "approved deployment operations"
    ]
  };
}
