const TOOL_CATALOG = [
  {
    key: "filesystem",
    name: "Isolated Filesystem",
    kind: "builtin",
    scopes: ["workspace:read", "workspace:write"],
    credentialScopes: []
  },
  {
    key: "shell",
    name: "Sandboxed Shell",
    kind: "builtin",
    scopes: ["process:execute"],
    credentialScopes: []
  },
  {
    key: "git",
    name: "Git",
    kind: "builtin",
    scopes: ["git:read", "git:write"],
    credentialScopes: []
  },
  {
    key: "browser",
    name: "Browser Automation",
    kind: "mcp",
    scopes: ["browser:navigate", "browser:inspect", "browser:test"],
    credentialScopes: []
  },
  {
    key: "node",
    name: "Node.js",
    kind: "builtin",
    scopes: ["process:execute"],
    credentialScopes: []
  },
  {
    key: "python",
    name: "Python",
    kind: "builtin",
    scopes: ["process:execute"],
    credentialScopes: []
  },
  {
    key: "database",
    name: "Database Adapter",
    kind: "mcp",
    scopes: ["database:read", "database:write"],
    credentialScopes: ["database"]
  },
  {
    key: "deploy-web",
    name: "Web Deployment Adapter",
    kind: "mcp",
    scopes: ["deployment:deploy"],
    credentialScopes: ["deployment"]
  },
  {
    key: "engine",
    name: "Game Engine Adapter",
    kind: "builtin",
    scopes: ["engine:read", "engine:write", "engine:build"],
    credentialScopes: []
  },
  {
    key: "assets",
    name: "Asset Workspace",
    kind: "builtin",
    scopes: ["assets:read", "assets:write"],
    credentialScopes: []
  },
  {
    key: "game-playtest",
    name: "Automated Game Playtest",
    kind: "builtin",
    scopes: ["playtest:run", "playtest:inspect"],
    credentialScopes: []
  },
  {
    key: "game-build",
    name: "Game Build Adapter",
    kind: "builtin",
    scopes: ["game-build:build", "game-build:package"],
    credentialScopes: []
  }
];

const TOOL_MAP = new Map(TOOL_CATALOG.map(tool => [tool.key, tool]));

export function listTools() {
  return TOOL_CATALOG.map(tool => ({ ...tool, scopes: [...tool.scopes], credentialScopes: [...tool.credentialScopes] }));
}

export function getTool(toolKey) {
  const tool = TOOL_MAP.get(toolKey);
  if (!tool) throw new Error("Unknown tool: " + toolKey);
  return { ...tool, scopes: [...tool.scopes], credentialScopes: [...tool.credentialScopes] };
}

export function requiredScopesForTools(toolKeys = []) {
  const scopes = new Set();
  for (const key of toolKeys) {
    for (const scope of getTool(key).scopes) scopes.add(scope);
  }
  return [...scopes].sort();
}
