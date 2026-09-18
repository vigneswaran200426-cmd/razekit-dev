import { id, transact, loadDb } from "./store.js";
import {
  AGENT_STATUS,
  AGENT_TYPES,
  TASK_STATUS,
  WORKER_STATUS,
  agentTypeForTask,
  toolManifestForTask
} from "./domain.js";

export async function spawnAgentForTask(taskId) {
  return transact(db => {
    const task = db.tasks.find(x => x.id === taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== TASK_STATUS.READY_FOR_AGENT) {
      throw new Error("Task must be ready_for_agent before spawning an agent");
    }

    const existing = db.agentInstances.find(x => x.taskId === taskId);
    if (existing) return existing;

    const agentType = agentTypeForTask(task.taskType);
    const now = new Date().toISOString();

    const workspace = {
      id: id("ws"),
      taskId,
      agentInstanceId: null,
      path: "/isolated-workspaces/" + taskId,
      status: "provisioning",
      createdAt: now,
      isolated: true
    };

    const worker = {
      id: id("worker"),
      taskId,
      agentInstanceId: null,
      runtime: agentType === AGENT_TYPES.KONAMI ? "game-worker" : "app-web-worker",
      status: WORKER_STATUS.PROVISIONING,
      heartbeatAt: null,
      createdAt: now
    };

    const agent = {
      id: id(agentType),
      taskId,
      agentType,
      status: AGENT_STATUS.PROVISIONING,
      workspaceId: workspace.id,
      workerId: worker.id,
      modelConfig: {
        orchestrator: "dual-model",
        primary: "fable-5.1",
        reasoningReviewer: "gpt-astra"
      },
      toolConfig: {
        manifest: toolManifestForTask(task.taskType, task.requestedTools || []),
        isolation: "task-scoped"
      },
      budgetLimit: task.maxBudget,
      budgetUsed: task.actualSpend || 0,
      iteration: 0,
      lastHeartbeat: null,
      createdAt: now,
      completedAt: null
    };

    workspace.agentInstanceId = agent.id;
    workspace.status = "ready";
    worker.agentInstanceId = agent.id;
    worker.status = WORKER_STATUS.READY;

    db.workspaces.push(workspace);
    db.workers.push(worker);
    db.agentInstances.push(agent);

    task.agentType = agentType;
    task.agentInstanceId = agent.id;
    task.status = TASK_STATUS.QUEUED;
    task.updatedAt = now;

    return agent;
  });
}

export async function startAgent(agentId) {
  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");

    const task = db.tasks.find(x => x.id === agent.taskId);
    const worker = db.workers.find(x => x.id === agent.workerId);
    const workspace = db.workspaces.find(x => x.id === agent.workspaceId);

    if (!task || !worker || !workspace) throw new Error("Agent isolation records are incomplete");
    if (![AGENT_STATUS.READY, AGENT_STATUS.PROVISIONING].includes(agent.status)) {
      throw new Error("Agent cannot start from status " + agent.status);
    }

    const now = new Date().toISOString();
    agent.status = AGENT_STATUS.RUNNING;
    agent.lastHeartbeat = now;
    agent.iteration += 1;

    worker.status = WORKER_STATUS.RUNNING;
    worker.heartbeatAt = now;
    workspace.status = "active";

    task.status = TASK_STATUS.RUNNING;
    task.updatedAt = now;

    db.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: "Agent " + agent.agentType + " started for task " + task.id + ".",
      metadata: {
        taskScoped: true,
        budgetLimit: agent.budgetLimit,
        toolCount: agent.toolConfig.manifest.filter(t => t.enabled).length
      },
      createdAt: now
    });

    return agent;
  });
}

export async function heartbeatAgent(agentId, progress = {}) {
  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");
    if (![AGENT_STATUS.RUNNING, AGENT_STATUS.WAITING_USER].includes(agent.status)) {
      throw new Error("Heartbeat not allowed from status " + agent.status);
    }

    const now = new Date().toISOString();
    agent.lastHeartbeat = now;
    agent.iteration += 1;

    const worker = db.workers.find(x => x.id === agent.workerId);
    if (worker) worker.heartbeatAt = now;

    if (progress.message) {
      db.agentMessages.push({
        id: id("msg"),
        agentInstanceId: agent.id,
        role: "agent",
        content: progress.message,
        metadata: {
          progress: progress.progress == null ? null : progress.progress,
          phase: progress.phase == null ? null : progress.phase
        },
        createdAt: now
      });
    }

    return {
      id: agent.id,
      status: agent.status,
      iteration: agent.iteration,
      lastHeartbeat: agent.lastHeartbeat,
      budgetUsed: agent.budgetUsed,
      budgetLimit: agent.budgetLimit
    };
  });
}

export async function cancelAgent(agentId, reason = "Cancelled by user") {
  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");

    const task = db.tasks.find(x => x.id === agent.taskId);
    const worker = db.workers.find(x => x.id === agent.workerId);
    const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
    const now = new Date().toISOString();

    agent.status = AGENT_STATUS.CANCELLED;
    agent.completedAt = now;
    if (worker) worker.status = WORKER_STATUS.STOPPED;
    if (workspace) workspace.status = "stopped";
    if (task) {
      task.status = TASK_STATUS.CANCELLED;
      task.updatedAt = now;
    }

    db.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: reason,
      metadata: { terminal: true },
      createdAt: now
    });

    return agent;
  });
}

export async function completeAgent(agentId, resultSummary = "Task completed") {
  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");

    const task = db.tasks.find(x => x.id === agent.taskId);
    const worker = db.workers.find(x => x.id === agent.workerId);
    const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
    const now = new Date().toISOString();

    agent.status = AGENT_STATUS.COMPLETED;
    agent.completedAt = now;
    if (worker) worker.status = WORKER_STATUS.STOPPED;
    if (workspace) workspace.status = "stopped";
    if (task) {
      task.status = TASK_STATUS.COMPLETED;
      task.updatedAt = now;
    }

    db.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: resultSummary,
      metadata: { terminal: true },
      createdAt: now
    });

    return agent;
  });
}

export async function listAgents() {
  const db = await loadDb();
  return db.agentInstances;
}

export async function getAgent(agentId) {
  const db = await loadDb();
  const agent = db.agentInstances.find(x => x.id === agentId);
  if (!agent) return null;

  return {
    ...agent,
    worker: db.workers.find(x => x.id === agent.workerId) || null,
    workspace: db.workspaces.find(x => x.id === agent.workspaceId) || null,
    task: db.tasks.find(x => x.id === agent.taskId) || null,
    messages: db.agentMessages.filter(x => x.agentInstanceId === agent.id)
  };
}
