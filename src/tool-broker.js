import { id, loadDb, transact } from "./store.js";
import { authorizeToolCall } from "./permission-broker.js";
import { getTool } from "./tool-registry.js";
import { resolveCredentialReference } from "./credential-vault.js";

export class ToolAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(toolKey, adapter) {
    getTool(toolKey);
    if (!adapter || typeof adapter.execute !== "function") {
      throw new Error("Tool adapter must implement execute()");
    }
    this.adapters.set(toolKey, adapter);
  }

  get(toolKey) {
    const adapter = this.adapters.get(toolKey);
    if (!adapter) throw new Error("No adapter configured for tool: " + toolKey);
    return adapter;
  }
}

export class ToolBroker {
  constructor({ registry } = {}) {
    if (!registry) throw new Error("Tool adapter registry is required");
    this.registry = registry;
  }

  async invoke({ agentInstanceId, toolKey, input = {}, scopes = [], credentialProvider = null }) {
    const decision = await authorizeToolCall(agentInstanceId, toolKey, scopes);
    const baseAudit = {
      id: id("toolcall"),
      agentInstanceId,
      taskId: (await this.getAgentTaskId(agentInstanceId)),
      toolKey,
      requestedScopes: decision.requestedScopes,
      createdAt: new Date().toISOString()
    };

    if (!decision.allowed) {
      const audit = await this.audit({
        ...baseAudit,
        status: "permission_required",
        missingScopes: decision.missingScopes,
        permissionRequestId: decision.permissionRequest.id
      });
      return { allowed: false, audit, permissionRequest: decision.permissionRequest };
    }

    const tool = decision.tool;
    let credential = null;
    if (tool.credentialScopes.length > 0) {
      credential = await resolveCredentialReference(
        agentInstanceId,
        credentialProvider || tool.key,
        tool.credentialScopes
      );
      if (!credential) {
        const audit = await this.audit({
          ...baseAudit,
          status: "credential_required"
        });
        return {
          allowed: false,
          audit,
          credentialRequired: tool.credentialScopes
        };
      }
    }

    const adapter = this.registry.get(toolKey);

    try {
      const result = await adapter.execute({
        agentInstanceId,
        tool,
        input,
        scopes: decision.grantedScopes,
        credential
      });

      const audit = await this.audit({
        ...baseAudit,
        status: "completed",
        resultSummary: summarizeResult(result)
      });

      return { allowed: true, result, audit };
    } catch (error) {
      const audit = await this.audit({
        ...baseAudit,
        status: "failed",
        error: error.message || "Tool execution failed"
      });
      throw Object.assign(error, { toolAuditId: audit.id });
    }
  }

  async getAgentTaskId(agentInstanceId) {
    const db = await loadDb();
    const agent = db.agentInstances.find(x => x.id === agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");
    return agent.taskId;
  }

  async audit(event) {
    return transact(db => {
      const item = {
        ...event,
        requestHash: hashStable({
          agentInstanceId: event.agentInstanceId,
          toolKey: event.toolKey,
          requestedScopes: event.requestedScopes,
          createdAt: event.createdAt
        })
      };
      db.toolCalls.push(item);
      return item;
    });
  }
}

function summarizeResult(result) {
  if (result == null) return null;
  if (typeof result === "string") return result.slice(0, 1000);
  try {
    return JSON.stringify(result).slice(0, 2000);
  } catch {
    return "[unserializable result]";
  }
}

function hashStable(value) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
