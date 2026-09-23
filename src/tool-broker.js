import { id, loadDb, transact } from "./store.js";
import { authorizeToolCall } from "./permission-broker.js";
import { getTool } from "./tool-registry.js";
import { resolveCredentialReference, requestCredentialReference } from "./credential-vault.js";
import { enforceTenantLimit } from "./abuse-controls.js";
import { tenantForTask, writeAudit } from "./tenant-security.js";
import { checkNodeToolScope } from "./jev-domain.js";

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

  has(toolKey) {
    return this.adapters.has(toolKey);
  }
}

export class ToolBroker {
  constructor({ registry } = {}) {
    if (!registry) throw new Error("Tool adapter registry is required");
    this.registry = registry;
  }

  async invoke({ agentInstanceId, toolKey, input = {}, scopes = [], credentialProvider = null, nodeId = null }) {
    const taskId = await this.getAgentTaskId(agentInstanceId);
    const tenantId = await tenantForTask(taskId);
    await enforceTenantLimit(tenantId, "toolCallsPerMinute", "tool.call");
    // The node is passed so a node-scoped approval applies to the node it was
    // granted for, and to no other.
    const decision = await authorizeToolCall(agentInstanceId, toolKey, scopes, { nodeId });
    const baseAudit = {
      id: id("toolcall"),
      agentInstanceId,
      taskId,
      toolKey,
      nodeId,
      requestedScopes: decision.requestedScopes,
      createdAt: new Date().toISOString()
    };

    // When the call is made on behalf of a graph node, the node's declared
    // scopes narrow what the agent's permissions already allow.
    //
    // This runs AFTER authorizeToolCall on purpose: `decision.requestedScopes`
    // is the resolved list, with an empty request already expanded to the
    // tool's full scope set. Checking the raw argument instead would let a call
    // that passed no scopes slip through the narrowing while still receiving
    // every scope the tool has.
    //
    // It also runs BEFORE any credential is resolved and before the adapter is
    // reached, so a step outside its declared scope never causes a secret to be
    // leased on its behalf.
    if (nodeId) {
      const node = await this.getGraphNode(nodeId, agentInstanceId);
      const verdict = checkNodeToolScope(node, toolKey, decision.requestedScopes);
      if (!verdict.allowed) {
        const audit = await this.audit({
          ...baseAudit,
          status: "scope_denied",
          missingScopes: verdict.missing,
          error: verdict.reason
        });
        return {
          allowed: false,
          audit,
          scopeDenied: true,
          missingScopes: verdict.missing,
          reason: verdict.reason
        };
      }
    }

    if (!decision.allowed) {
      const audit = await this.audit({
        ...baseAudit,
        status: "permission_required",
        missingScopes: decision.missingScopes,
        permissionRequestId: decision.permissionRequest.id
      });
      return {
        allowed: false,
        audit,
        permissionRequest: decision.permissionRequest
      };
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
        const credentialRequest = await requestCredentialReference(
          agentInstanceId,
          credentialProvider || tool.key,
          tool.credentialScopes
        );
        const audit = await this.audit({
          ...baseAudit,
          status: "credential_required",
          credentialScopes: tool.credentialScopes,
          credentialRequestId: credentialRequest.id
        });
        return {
          allowed: false,
          audit,
          credentialRequired: tool.credentialScopes,
          credentialRequest
        };
      }
    }

    let adapter;
    try {
      adapter = this.registry.get(toolKey);
    } catch (error) {
      const audit = await this.audit({
        ...baseAudit,
        status: "adapter_unavailable",
        error: error.message || "Tool adapter unavailable"
      });
      return { allowed: false, audit, adapterUnavailable: true };
    }

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
      error.toolAuditId = audit.id;
      throw error;
    }
  }

  async getAgentTaskId(agentInstanceId) {
    const db = await loadDb();
    const agent = db.agentInstances.find(x => x.id === agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");
    return agent.taskId;
  }

  /**
   * The node a call claims to be running under.
   *
   * The node must belong to the calling agent's own task. Without that check
   * `nodeId` would be a way to borrow another task's — and so potentially
   * another tenant's — declared scopes by quoting an id, which would make the
   * narrowing worse than useless.
   */
  async getGraphNode(nodeId, agentInstanceId) {
    const db = await loadDb();
    const agent = db.agentInstances.find(x => x.id === agentInstanceId);
    if (!agent) throw new Error("Agent instance not found");
    const node = db.graphNodes.find(x => x.id === nodeId);
    if (!node) throw new Error("Unknown graph node: " + nodeId);
    if (node.taskId !== agent.taskId) {
      throw new Error("Graph node does not belong to this agent's task");
    }
    return node;
  }

  async audit(event) {
    const item = await transact(db => {
      const record = {
        ...event,
        requestHash: hashStable({
          agentInstanceId: event.agentInstanceId,
          toolKey: event.toolKey,
          requestedScopes: event.requestedScopes,
          createdAt: event.createdAt
        })
      };
      db.toolCalls.push(record);
      return record;
    });
    await writeAudit({
      tenantId: await tenantForTask(event.taskId),
      action: "tool.call",
      resourceType: "tool",
      resourceId: item.id,
      // A refusal is not a success. "scope_denied" in particular is a security
      // event — a step reaching for a tool it never declared — and recording it
      // as an ordinary successful tool call is how it would go unnoticed in the
      // one log built to notice it.
      outcome: ["failed", "scope_denied"].includes(item.status) ? "failed" : "success",
      metadata: {
        toolKey: item.toolKey,
        status: item.status,
        nodeId: item.nodeId ?? null,
        requestedScopes: item.requestedScopes
      }
    });
    return item;
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
