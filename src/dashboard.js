import { id, loadDb, transact } from "./store.js";
import { AGENT_STATUS, TASK_STATUS } from "./domain.js";
import { latestVerification } from "./verification.js";
import { addAgentMessage } from "./agent-manager.js";
import { writeAudit, tenantForTask } from "./tenant-security.js";

export const USER_DASHBOARD_STATUS = {
  WORKING: "WORKING",
  DECISION_NEEDED: "DECISION NEEDED",
  IMPORTANT_UPDATE: "IMPORTANT UPDATE",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED"
};

const SAFE_CHANGE_PATTERNS = [
  /dark mode|light mode|theme/i,
  /color|colour|font|typography|spacing|padding|margin|radius|border/i,
  /homepage|landing page|layout|alignment|copy|text|headline|button label/i,
  /animation|motion|transition|microinteraction/i,
  /responsive|mobile layout|desktop layout|tablet layout/i
];

const SCOPE_CHANGE_PATTERNS = [
  /razorpay|stripe|cashfree|payment|checkout|subscription|billing/i,
  /credential|api key|secret|oauth|login provider|authentication|authorization/i,
  /database|postgres|mysql|neon|supabase/i,
  /deploy|deployment|hosting|cloudflare|vercel|render/i,
  /external api|third[- ]party|integration|webhook/i,
  /multiplayer|multiplayer mode|real[- ]time/i,
  /add (a )?(new )?(feature|page|screen|service|integration)/i,
  /android|ios|mobile app|desktop app|browser extension/i,
  /new engine|unity|unreal|godot/i
];

function latestRun(db, taskId) {
  return db.executionRuns
    .filter(run => run.taskId === taskId)
    .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))[0] || null;
}

function progressFromRun(run) {
  const steps = run?.result?.plan?.steps || [];
  if (steps.length === 0) return {
    percent: 0,
    steps: { total: 0, passed: 0, failed: 0, active: null },
    phase: null
  };
  const passed = steps.filter(step => step.state === "passed").length;
  const active = steps.find(step => !["passed", "failed", "cancelled"].includes(step.state));
  return {
    percent: Math.min(90, Math.round((passed / steps.length) * 90)),
    steps: {
      total: steps.length,
      passed,
      failed: steps.filter(step => step.state === "failed").length,
      active: active?.id || null
    },
    phase: active?.phase || steps[steps.length - 1]?.phase || null
  };
}

function acceptanceProgress(criteria) {
  if (criteria.length === 0) return { percent: 0, passed: 0, total: 0 };
  const passed = criteria.filter(item => item.status === "passed").length;
  return {
    percent: Math.round((passed / criteria.length) * 10),
    passed,
    total: criteria.length
  };
}

function progressSnapshot(task, agent, run, criteria) {
  if (task.status === TASK_STATUS.COMPLETED || agent?.status === AGENT_STATUS.COMPLETED) {
    return {
      percent: 100,
      steps: progressFromRun(run).steps,
      acceptance: acceptanceProgress(criteria),
      phase: "completed"
    };
  }
  const execution = progressFromRun(run);
  const acceptance = acceptanceProgress(criteria);
  return {
    percent: Math.min(99, execution.percent + acceptance.percent),
    steps: execution.steps,
    acceptance,
    phase: execution.phase || (agent?.executionState || "initializing")
  };
}

function classifyChange(content) {
  const text = content.trim();
  const scopeMatch = SCOPE_CHANGE_PATTERNS.find(pattern => pattern.test(text));
  if (scopeMatch) {
    const highRisk = /payment|razorpay|stripe|cashfree|credential|api key|secret|oauth|authentication|database|deploy|deployment|external api|third[- ]party/i.test(text);
    return {
      category: "scope",
      impact: highRisk ? "high" : "medium",
      requiresDecision: true,
      estimatedCost: highRisk ? 15 : 8,
      reason: "This change can introduce a new service, permission, integration, or material scope."
    };
  }

  const safeMatch = SAFE_CHANGE_PATTERNS.some(pattern => pattern.test(text));
  if (safeMatch) {
    return {
      category: "in-scope",
      impact: "low",
      requiresDecision: false,
      estimatedCost: 0,
      reason: "This is an in-scope presentation or behavior refinement."
    };
  }

  return {
    category: "review",
    impact: "medium",
    requiresDecision: true,
    estimatedCost: 5,
    reason: "The requested change is not confidently classified as an in-scope refinement."
  };
}

function budgetImpact(agent, task, estimatedCost) {
  const used = Number(agent?.budgetUsed ?? task.actualSpend ?? 0);
  const limit = Number(task.maxBudget);
  const remaining = Math.max(0, limit - used);
  const projected = used + estimatedCost;
  return {
    currentSpend: used,
    maxBudget: limit,
    remaining,
    estimatedIncrement: estimatedCost,
    projectedSpend: projected,
    withinBudget: projected <= limit
  };
}

function applyDecisionState(db, agent, task, waiting) {
  if (!agent) return;
  if (waiting) {
    agent.status = AGENT_STATUS.WAITING_USER;
    agent.executionState = "waiting_user";
    task.status = TASK_STATUS.WAITING_USER;
  } else if ([AGENT_STATUS.WAITING_USER, AGENT_STATUS.BLOCKED].includes(agent.status)) {
    agent.status = AGENT_STATUS.RUNNING;
    agent.executionState = "running";
    task.status = TASK_STATUS.RUNNING;
    agent.lastHeartbeat = new Date().toISOString();
  }
  task.updatedAt = new Date().toISOString();
}

function currentDashboardStatus(task, agent, pendingChanges) {
  if (task.status === TASK_STATUS.COMPLETED || agent?.status === AGENT_STATUS.COMPLETED) return USER_DASHBOARD_STATUS.COMPLETED;
  if (pendingChanges.length > 0 || task.status === TASK_STATUS.WAITING_USER || agent?.status === AGENT_STATUS.WAITING_USER) {
    return USER_DASHBOARD_STATUS.DECISION_NEEDED;
  }
  if (task.status === TASK_STATUS.FAILED || task.status === TASK_STATUS.CANCELLED || agent?.status === AGENT_STATUS.FAILED || agent?.status === AGENT_STATUS.BLOCKED) {
    return USER_DASHBOARD_STATUS.BLOCKED;
  }
  if ([TASK_STATUS.RUNNING, TASK_STATUS.QUEUED, TASK_STATUS.READY_FOR_AGENT].includes(task.status)) {
    return USER_DASHBOARD_STATUS.WORKING;
  }
  return USER_DASHBOARD_STATUS.IMPORTANT_UPDATE;
}

function dashboardEvents(db, task, agent, pendingChanges) {
  const updates = db.userUpdates
    .filter(item => item.taskId === task.id)
    .map(item => ({
      id: item.id,
      status: item.status,
      title: item.title,
      message: item.message,
      createdAt: item.createdAt,
      changeId: item.changeId || null
    }));

  if (pendingChanges.length) {
    updates.push({
      id: "pending-" + task.id,
      status: USER_DASHBOARD_STATUS.DECISION_NEEDED,
      title: "Decision needed",
      message: pendingChanges[0].reason,
      createdAt: pendingChanges[0].createdAt,
      changeId: pendingChanges[0].id
    });
  }

  if (updates.length === 0) {
    const status = currentDashboardStatus(task, agent, pendingChanges);
    updates.push({
      id: "status-" + task.id,
      status,
      title: status === USER_DASHBOARD_STATUS.WORKING ? "Agent is working" : "Task status",
      message: task.title,
      createdAt: task.updatedAt || task.createdAt,
      changeId: null
    });
  }

  return updates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20);
}

function deliverablesFromRun(run) {
  if (!run) return [];
  const outputs = [];
  for (const artifact of run.artifacts || []) {
    if (typeof artifact === "string") outputs.push({ type: "artifact", path: artifact, runId: run.id });
    else if (artifact) outputs.push({ type: artifact.type || "artifact", path: artifact.path || artifact.manifest || null, runId: run.id });
  }

  for (const step of run.result?.plan?.steps || []) {
    if (step.state !== "passed") continue;
    const result = step.result || {};
    if (result.path) outputs.push({ type: step.kind, path: result.path, runId: run.id });
    if (result.manifest) outputs.push({ type: step.kind, path: result.manifest, runId: run.id });
    for (const file of result.files || []) {
      outputs.push({
        type: step.kind,
        path: typeof file === "string" ? file : file?.path || null,
        runId: run.id
      });
    }
  }

  const seen = new Set();
  return outputs.filter(item => {
    const key = item.type + ":" + item.path;
    if (!item.path || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function changeAnalysis(content, task, agent) {
  if (!content?.trim()) throw new Error("Change content is required");
  const classification = classifyChange(content);
  const budget = budgetImpact(agent, task, classification.estimatedCost);
  return {
    ...classification,
    budget,
    requiresApproval: classification.requiresDecision || !budget.withinBudget
  };
}

export async function submitUserCommand(taskId, content) {
  const db = await loadDb();
  const task = db.tasks.find(item => item.id === taskId);
  if (!task) throw new Error("Task not found");
  const agent = task.agentInstanceId ? db.agentInstances.find(item => item.id === task.agentInstanceId) : null;
  if (!agent) throw new Error("Task has no agent instance");
  if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED].includes(task.status)) {
    throw new Error("Completed or cancelled tasks cannot accept new changes");
  }

  const analysis = changeAnalysis(content, task, agent);
  if (analysis.requiresApproval) {
    const change = await transact(state => {
      const currentTask = state.tasks.find(item => item.id === taskId);
      const currentAgent = state.agentInstances.find(item => item.id === currentTask.agentInstanceId);
      const pending = {
        id: id("change"),
        taskId,
        agentInstanceId: currentAgent.id,
        content: content.trim(),
        category: analysis.category,
        impact: analysis.impact,
        estimatedCost: analysis.estimatedCost,
        reason: analysis.budget.withinBudget ? analysis.reason : "This change exceeds the remaining hard budget unless the task budget is increased.",
        status: "pending",
        budgetSnapshot: analysis.budget,
        createdAt: new Date().toISOString(),
        resolvedAt: null
      };
      state.taskChangeRequests.push(pending);
      applyDecisionState(state, currentAgent, currentTask, true);
      state.userUpdates.push({
        id: id("update"),
        taskId,
        status: USER_DASHBOARD_STATUS.DECISION_NEEDED,
        title: "Decision needed",
        message: pending.reason,
        changeId: pending.id,
        createdAt: pending.createdAt
      });
      return pending;
    });

    await addAgentMessage(agent.id, "user", content, {
      source: "task-dashboard",
      changeId: change.id,
      impact: change.impact,
      requiresApproval: true
    });
    return { mode: "decision_needed", change, analysis };
  }

  const change = await transact(state => {
    const currentTask = state.tasks.find(item => item.id === taskId);
    const currentAgent = state.agentInstances.find(item => item.id === currentTask.agentInstanceId);
    const now = new Date().toISOString();
    const applied = {
      id: id("change"),
      taskId,
      agentInstanceId: currentAgent.id,
      content: content.trim(),
      category: analysis.category,
      impact: analysis.impact,
      estimatedCost: analysis.estimatedCost,
      reason: analysis.reason,
      status: "applied",
      budgetSnapshot: analysis.budget,
      createdAt: now,
      resolvedAt: now
    };
    currentTask.specification = [currentTask.specification, "User change: " + content.trim()].filter(Boolean).join("\n\n");
    if (!Array.isArray(currentTask.userChanges)) currentTask.userChanges = [];
    currentTask.userChanges.push({ id: applied.id, content: applied.content, createdAt: now });
    state.taskChangeRequests.push(applied);
    state.userUpdates.push({
      id: id("update"),
      taskId,
      status: USER_DASHBOARD_STATUS.IMPORTANT_UPDATE,
      title: "Change applied",
      message: content.trim(),
      changeId: applied.id,
      createdAt: now
    });
    return applied;
  });

  await addAgentMessage(agent.id, "user", content, {
    source: "task-dashboard",
    changeId: change.id,
    impact: change.impact,
    requiresApproval: false
  });
  await writeAudit({
    tenantId: await tenantForTask(taskId),
    action: "task.change.apply",
    resourceType: "task",
    resourceId: taskId,
    metadata: { changeId: change.id, category: change.category }
  });
  return { mode: "applied", change, analysis };
}

export async function approveChange(taskId, changeId, { maxBudget = null } = {}) {
  const result = await transact(db => {
    const change = db.taskChangeRequests.find(item => item.id === changeId && item.taskId === taskId);
    if (!change) throw new Error("Change request not found");
    if (change.status !== "pending") throw new Error("Change request is already resolved");

    const task = db.tasks.find(item => item.id === taskId);
    const agent = db.agentInstances.find(item => item.id === task?.agentInstanceId);
    if (!task || !agent) throw new Error("Task agent is not available");

    const requestedBudget = maxBudget == null ? Number(task.maxBudget) : Number(maxBudget);
    if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) throw new Error("maxBudget must be a positive number");

    const used = Number(agent.budgetUsed || 0);
    const required = used + Number(change.estimatedCost || 0);
    if (requestedBudget < required) {
      throw new Error("Approved change would exceed the hard budget. increase maxBudget to at least " + required);
    }

    task.maxBudget = Math.max(Number(task.maxBudget), requestedBudget);
    task.updatedAt = new Date().toISOString();
    task.specification = [task.specification, "User change: " + change.content].filter(Boolean).join("\n\n");
    if (!Array.isArray(task.userChanges)) task.userChanges = [];
    task.userChanges.push({ id: change.id, content: change.content, createdAt: new Date().toISOString() });

    change.status = "approved";
    change.resolvedAt = new Date().toISOString();
    change.budgetSnapshot = budgetImpact(agent, task, Number(change.estimatedCost || 0));

    const remainingPending = db.taskChangeRequests.filter(item => item.taskId === taskId && item.status === "pending" && item.id !== change.id);
    applyDecisionState(db, agent, task, remainingPending.length > 0);

    db.userUpdates.push({
      id: id("update"),
      taskId,
      status: remainingPending.length > 0 ? USER_DASHBOARD_STATUS.DECISION_NEEDED : USER_DASHBOARD_STATUS.WORKING,
      title: "Change approved",
      message: change.content,
      changeId: change.id,
      createdAt: new Date().toISOString()
    });

    return { change, task, agent };
  });

  await addAgentMessage(result.agent.id, "user", result.change.content, {
    source: "task-dashboard",
    changeId: result.change.id,
    approved: true
  });
  await writeAudit({
    tenantId: await tenantForTask(taskId),
    action: "task.change.approve",
    resourceType: "task",
    resourceId: taskId,
    metadata: { changeId: result.change.id, budget: result.change.budgetSnapshot }
  });
  return result;
}

export async function denyChange(taskId, changeId, reason = "User declined the requested change") {
  return transact(db => {
    const change = db.taskChangeRequests.find(item => item.id === changeId && item.taskId === taskId);
    if (!change) throw new Error("Change request not found");
    if (change.status !== "pending") throw new Error("Change request is already resolved");

    const task = db.tasks.find(item => item.id === taskId);
    const agent = db.agentInstances.find(item => item.id === task?.agentInstanceId);
    if (!task || !agent) throw new Error("Task agent is not available");

    change.status = "denied";
    change.resolvedAt = new Date().toISOString();
    change.resolutionReason = reason;

    const remainingPending = db.taskChangeRequests.filter(item => item.taskId === taskId && item.status === "pending");
    applyDecisionState(db, agent, task, remainingPending.length > 0);

    db.userUpdates.push({
      id: id("update"),
      taskId,
      status: remainingPending.length > 0 ? USER_DASHBOARD_STATUS.DECISION_NEEDED : USER_DASHBOARD_STATUS.WORKING,
      title: "Change declined",
      message: reason,
      changeId: change.id,
      createdAt: new Date().toISOString()
    });

    return { change, task, agent };
  }).then(async result => {
    await writeAudit({
      tenantId: result.task.tenantId || "local-tenant",
      action: "task.change.deny",
      resourceType: "task",
      resourceId: taskId,
      metadata: { changeId: result.change.id, reason }
    });
    return result;
  });
}

export async function taskDashboard(taskId) {
  const db = await loadDb();
  const task = db.tasks.find(item => item.id === taskId);
  if (!task) return null;

  const agent = task.agentInstanceId ? db.agentInstances.find(item => item.id === task.agentInstanceId) : null;
  const criteria = db.acceptanceCriteria.filter(item => item.taskId === taskId);
  const pendingChanges = db.taskChangeRequests
    .filter(item => item.taskId === taskId && item.status === "pending")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const run = latestRun(db, taskId);
  const verification = agent ? await latestVerification(agent.id) : null;
  const progress = progressSnapshot(task, agent, run, criteria);
  const budget = budgetImpact(agent, task, 0);
  const currentStatus = currentDashboardStatus(task, agent, pendingChanges);

  return {
    task: {
      id: task.id,
      title: task.title,
      taskType: task.taskType,
      status: task.status,
      agentType: task.agentType,
      specification: task.specification
    },
    status: currentStatus,
    progress,
    budget: {
      ...budget,
      percentUsed: budget.maxBudget > 0 ? Math.round((budget.currentSpend / budget.maxBudget) * 100) : 0
    },
    pendingDecisions: pendingChanges,
    verification: verification
      ? { status: verification.status, failures: verification.failures || [], createdAt: verification.createdAt }
      : null,
    deliverables: deliverablesFromRun(run),
    events: dashboardEvents(db, task, agent, pendingChanges),
    chat: db.agentMessages
      .filter(item => agent && item.agentInstanceId === agent.id)
      .filter(item => !item.metadata?.toolCall && !item.metadata?.testEvent && !item.metadata?.lowLevel)
      .slice(-40),
    updatedAt: task.updatedAt || task.createdAt
  };
}

export async function taskEvents(taskId) {
  const dashboard = await taskDashboard(taskId);
  return dashboard?.events || null;
}
