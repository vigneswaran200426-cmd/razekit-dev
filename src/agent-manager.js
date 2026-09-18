import { mkdir } from "node:fs/promises";
import path from "node:path";
import { id, transact, loadDb } from "./store.js";
import {
  AGENT_STATUS,
  AGENT_TYPES,
  TASK_STATUS,
  WORKER_STATUS,
  agentTypeForTask,
  toolManifestForTask
} from "./domain.js";
import { WORKER_RUNTIME_STATE } from "./runtime-domain.js";
import { verifyTask } from "./verification.js";

const WORKSPACE_ROOT = path.resolve(process.env.RAZEKIT_WORKSPACE_ROOT || "data/workspaces");

async function provisionWorkspace(taskId) {
  const workspacePath = path.join(WORKSPACE_ROOT, taskId);
  await mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

export async function spawnAgentForTask(taskId) {
  const existing = await (async () => {
    const db = await loadDb();
    return db.agentInstances.find(x => x.taskId === taskId) || null;
  })();
  if (existing) return existing;

  const db = await loadDb();
  const task = db.tasks.find(x => x.id === taskId);
  if (!task) throw new Error("Task not found");
  if (task.status !== TASK_STATUS.READY_FOR_AGENT) {
    throw new Error("Task must be ready_for_agent before spawning an agent");
  }
  if (!task.authorization?.autonomousExecution) {
    throw new Error("Task has not been authorized for autonomous execution");
  }
  if (!Number.isFinite(Number(task.maxBudget)) || Number(task.maxBudget) <= 0) {
    throw new Error("Task has no valid hard budget limit");
  }

  const workspacePath = await provisionWorkspace(taskId);

  return transact(state => {
    const duplicate = state.agentInstances.find(x => x.taskId === taskId);
    if (duplicate) return duplicate;

    const freshTask = state.tasks.find(x => x.id === taskId);
    if (!freshTask) throw new Error("Task not found");
    if (freshTask.status !== TASK_STATUS.READY_FOR_AGENT) {
      throw new Error("Task is no longer ready for agent spawning");
    }

    const agentType = agentTypeForTask(freshTask.taskType);
    const now = new Date().toISOString();

    const workspace = {
      id: id("ws"),
      taskId,
      agentInstanceId: null,
      path: workspacePath,
      status: "ready",
      isolated: true,
      createdAt: now,
      stoppedAt: null
    };

    const worker = {
      id: id("worker"),
      taskId,
      agentInstanceId: null,
      runtime: agentType === AGENT_TYPES.KONAMI ? "game-worker" : "app-web-worker",
      status: WORKER_STATUS.READY,
      runtimeState: WORKER_RUNTIME_STATE.READY,
      heartbeatAt: null,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      checkpoint: null,
      checkpointAt: null,
      createdAt: now,
      stoppedAt: null
    };

    const agent = {
      id: id(agentType),
      taskId,
      agentType,
      status: AGENT_STATUS.READY,
      workspaceId: workspace.id,
      workerId: worker.id,
      modelConfig: {
        orchestrator: "dual-model",
        primary: "fable-5.1",
        reasoningReviewer: "gpt-astra"
      },
      toolConfig: {
        manifest: toolManifestForTask(freshTask.taskType, freshTask.requestedTools || []),
        isolation: "task-scoped"
      },
      budgetLimit: Number(freshTask.maxBudget),
      budgetUsed: Number(freshTask.actualSpend || 0),
      iteration: 0,
      executionState: "ready",
      lastHeartbeat: null,
      createdAt: now,
      completedAt: null
    };

    workspace.agentInstanceId = agent.id;
    worker.agentInstanceId = agent.id;

    state.workspaces.push(workspace);
    state.workers.push(worker);
    state.agentInstances.push(agent);

    freshTask.agentType = agentType;
    freshTask.agentInstanceId = agent.id;
    freshTask.status = TASK_STATUS.QUEUED;
    freshTask.updatedAt = now;

    state.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: "Agent instance provisioned.",
      metadata: { taskScoped: true, agentType, workspacePath },
      createdAt: now
    });

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

    if (!task || !worker || !workspace) {
      throw new Error("Agent isolation records are incomplete");
    }
    if (![AGENT_STATUS.READY, AGENT_STATUS.PROVISIONING].includes(agent.status)) {
      throw new Error("Agent cannot start from status " + agent.status);
    }
    if (!task.authorization?.autonomousExecution) {
      throw new Error("Task is not authorized for autonomous execution");
    }

    const now = new Date().toISOString();
    agent.status = AGENT_STATUS.RUNNING;
    agent.executionState = "running";
    agent.lastHeartbeat = now;
    agent.iteration += 1;

    worker.status = WORKER_STATUS.RUNNING;
    worker.runtimeState = WORKER_RUNTIME_STATE.RUNNING;
    worker.heartbeatAt = now;

    workspace.status = "active";
    task.status = TASK_STATUS.RUNNING;
    task.updatedAt = now;

    db.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: "Agent " + agent.agentType + " started.",
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

export async function processReadyTasks() {
  const db = await loadDb();
  const ready = db.tasks.filter(task => task.status === TASK_STATUS.READY_FOR_AGENT && task.authorization?.autonomousExecution);
  const started = [];

  for (const task of ready) {
    const agent = await spawnAgentForTask(task.id);
    const current = await getAgent(agent.id);
    if (current?.status === AGENT_STATUS.READY) {
      started.push(await startAgent(agent.id));
    } else {
      started.push(agent);
    }
  }

  return started;
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

export async function addAgentMessage(agentId, role, content, metadata = {}) {
  if (!content?.trim()) throw new Error("Message content is required");
  if (!["user", "agent", "system"].includes(role)) throw new Error("Invalid message role");

  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");

    const message = {
      id: id("msg"),
      agentInstanceId: agent.id,
      role,
      content: content.trim(),
      metadata,
      createdAt: new Date().toISOString()
    };

    db.agentMessages.push(message);
    return message;
  });
}

export async function setAcceptanceCriterion(taskId, criterionId, status, evidence = null) {
  const allowed = new Set(["pending", "passed", "failed", "skipped"]);
  if (!allowed.has(status)) throw new Error("Invalid acceptance criterion status");

  return transact(db => {
    const criterion = db.acceptanceCriteria.find(x => x.id === criterionId && x.taskId === taskId);
    if (!criterion) throw new Error("Acceptance criterion not found");
    criterion.status = status;
    criterion.evidence = evidence;
    criterion.updatedAt = new Date().toISOString();
    return criterion;
  });
}

export async function acceptanceForTask(taskId) {
  const db = await loadDb();
  return db.acceptanceCriteria.filter(x => x.taskId === taskId);
}

export async function recordSpend(agentId, amount, reason = "billable action") {
  const spend = Number(amount);
  if (!Number.isFinite(spend) || spend < 0) throw new Error("Spend amount must be a non-negative number");

  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");

    const nextSpend = Number(agent.budgetUsed || 0) + spend;
    if (nextSpend > Number(agent.budgetLimit)) {
      throw new Error("Hard budget limit exceeded");
    }

    agent.budgetUsed = nextSpend;
    const task = db.tasks.find(x => x.id === agent.taskId);
    if (task) {
      task.actualSpend = nextSpend;
      task.updatedAt = new Date().toISOString();
    }

    const event = {
      id: id("spend"),
      agentInstanceId: agent.id,
      amount: spend,
      reason,
      totalAfter: nextSpend,
      createdAt: new Date().toISOString()
    };

    db.agentMessages.push({
      id: id("msg"),
      agentInstanceId: agent.id,
      role: "system",
      content: "Spend recorded: " + spend,
      metadata: { billingEvent: event },
      createdAt: event.createdAt
    });

    return event;
  });
}

async function terminalTransition(agentId, status, taskStatus, reason) {
  return transact(db => {
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");

    const task = db.tasks.find(x => x.id === agent.taskId);
    const worker = db.workers.find(x => x.id === agent.workerId);
    const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
    const now = new Date().toISOString();

    agent.status = status;
    agent.executionState = "stopped";
    agent.completedAt = now;

    if (worker) {
      worker.status = WORKER_STATUS.STOPPED;
      worker.runtimeState = WORKER_RUNTIME_STATE.STOPPED;
      worker.stoppedAt = now;
    }
    if (workspace) {
      workspace.status = "stopped";
      workspace.stoppedAt = now;
    }
    if (task) {
      task.status = taskStatus;
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

export async function cancelAgent(agentId, reason = "Cancelled by user") {
  return terminalTransition(agentId, AGENT_STATUS.CANCELLED, TASK_STATUS.CANCELLED, reason);
}

export async function completeAgent(agentId, resultSummary = "Task completed") {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error("Agent instance not found");

  const verification = await verifyTask(agentId);
  if (verification.status !== "passed") {
    throw new Error("Agent cannot complete: objective verification failed; acceptance criteria pass required");
  }

  const criteria = await acceptanceForTask(agent.taskId);
  const incomplete = criteria.filter(x => x.status !== "passed");
  if (incomplete.length > 0) {
    throw new Error("Agent cannot complete until all acceptance criteria pass");
  }

  return terminalTransition(agentId, AGENT_STATUS.COMPLETED, TASK_STATUS.COMPLETED, resultSummary);
}

export async function failAgent(agentId, reason = "Agent failed") {
  return terminalTransition(agentId, AGENT_STATUS.FAILED, TASK_STATUS.FAILED, reason);
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
