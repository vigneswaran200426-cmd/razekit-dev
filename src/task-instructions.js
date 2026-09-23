import { loadDb, transact, id } from "./store.js";
import { predictTaskRequirements, narrowPreauthorizedScopes } from "./task-lifecycle.js";

// What the task was asked to do, over time.
//
// approveChange used to do this:
//
//   task.specification = [task.specification, "User change: " + change.content].join("\n\n")
//
// which is the one thing a record of instructions must never do. After three
// changes there is no way to answer "what did the user actually ask for", "what
// was this work authorized against", or "when did the scope grow" — the
// original and every amendment have been flattened into one blob, and the blob
// is what the models are handed.
//
// So instructions are versioned and append-only. A change produces a NEW
// version that supersedes the last one; nothing already written is edited.
// `task.specification` is kept in step as a convenience for readers that expect
// it, but the versions are the record.

/**
 * The instruction the task is currently working to.
 *
 * Creates v1 from the task's own specification the first time it is asked,
 * because tasks created before this existed have a specification and no
 * version — and a task whose history starts at v2 is worse than one whose
 * history starts late.
 */
export async function currentInstruction(taskId) {
  const db = await loadDb();
  const versions = db.taskInstructions
    .filter(item => item.taskId === taskId)
    .sort((a, b) => a.version - b.version);

  if (versions.length > 0) return versions[versions.length - 1];

  const task = db.tasks.find(item => item.id === taskId);
  if (!task) return null;

  return transact(state => {
    // Re-checked inside the transaction: two readers racing must not create
    // two version ones.
    const existing = state.taskInstructions.filter(item => item.taskId === taskId);
    if (existing.length > 0) return existing[existing.length - 1];

    const current = state.tasks.find(item => item.id === taskId);
    const record = {
      id: id("instr"),
      taskId,
      version: 1,
      text: current.specification || current.originalRequest || "",
      changeId: null,
      supersedes: null,
      authoredBy: current.userId || "user",
      reason: "original request",
      createdAt: current.createdAt || new Date().toISOString()
    };
    state.taskInstructions.push(record);
    return record;
  });
}

export async function instructionHistory(taskId) {
  const db = await loadDb();
  return db.taskInstructions
    .filter(item => item.taskId === taskId)
    .sort((a, b) => a.version - b.version);
}

/**
 * Record a new instruction version.
 *
 * The new text is the previous text plus the change, which is the honest
 * reading of "also do this" — but the previous version stays exactly as it was,
 * so what the task was authorized against at each point is still answerable.
 */
export async function appendInstructionVersion({
  taskId,
  changeId = null,
  text = null,
  addition = null,
  reason = "user change",
  authoredBy = "user",
  now = new Date()
}) {
  const previous = await currentInstruction(taskId);
  if (!previous) throw new Error("Task not found: " + taskId);

  const nextText = text !== null
    ? String(text)
    : [previous.text, addition].filter(Boolean).join("\n\n");

  return transact(db => {
    const versions = db.taskInstructions.filter(item => item.taskId === taskId);
    const version = versions.reduce((max, item) => Math.max(max, item.version), 0) + 1;

    const record = {
      id: id("instr"),
      taskId,
      version,
      text: nextText,
      changeId,
      supersedes: previous.id,
      authoredBy,
      reason,
      createdAt: now.toISOString()
    };
    db.taskInstructions.push(record);

    // Kept in step for readers that expect it. The versions are the record;
    // this is a cache of the newest one, not a second history.
    const task = db.tasks.find(item => item.id === taskId);
    if (task) {
      task.specification = nextText;
      task.instructionVersion = version;
      task.updatedAt = record.createdAt;
    }

    return record;
  });
}

/**
 * What an approved change would actually do.
 *
 * Four separate answers, because they are four separate decisions and a single
 * "impact: medium" tells the user nothing they can act on. In particular
 * PERMISSION impact is called out on its own: a change that quietly needs a
 * deployment is a different thing from one that needs a bigger budget, and the
 * user should not have to infer it from a cost.
 */
export async function analyzeChangeImpact({ taskId, content }) {
  const db = await loadDb();
  const task = db.tasks.find(item => item.id === taskId);
  if (!task) throw new Error("Task not found: " + taskId);

  const agent = db.agentInstances.find(item => item.id === task.agentInstanceId) || null;
  const instruction = await currentInstruction(taskId);

  // Predicted against the CHANGE plus the existing instruction: a change is
  // read in the context of the task, not on its own.
  const before = predictTaskRequirements({
    taskType: task.taskType,
    title: task.title,
    originalRequest: instruction?.text || task.originalRequest,
    specification: instruction?.text || task.specification
  });
  const after = predictTaskRequirements({
    taskType: task.taskType,
    title: task.title,
    originalRequest: [instruction?.text, content].filter(Boolean).join("\n\n"),
    specification: [instruction?.text, content].filter(Boolean).join("\n\n")
  });

  const newTools = after.tools.filter(tool => !before.tools.includes(tool));
  const newScopes = after.toolScopes.filter(scope => !before.toolScopes.includes(scope));
  const authorized = new Set(task.authorization?.toolScopes || []);
  const narrowed = narrowPreauthorizedScopes(newScopes, after.tools);

  const graph = db.taskGraphs.find(item => item.taskId === taskId && !["succeeded", "failed", "cancelled"].includes(item.status));
  const unstartedNodes = graph
    ? db.graphNodes.filter(node => node.graphId === graph.id && ["pending", "ready"].includes(node.status))
    : [];

  return {
    isPrediction: true,
    requirements: {
      // The change is added to the instruction; nothing already asked for is
      // removed by it, because a change request cannot un-say the original.
      currentVersion: instruction?.version ?? 1,
      nextVersion: (instruction?.version ?? 1) + 1,
      addition: content
    },
    permissions: {
      newTools,
      newScopes,
      // Which of those the task may do without asking, and which will stop it.
      alreadyAuthorized: newScopes.filter(scope => authorized.has(scope)),
      wouldNeedApproval: newScopes.filter(scope => !authorized.has(scope)),
      neverPreauthorized: narrowed.refused.map(item => item.scope)
    },
    budget: {
      limit: Number(task.maxBudget),
      used: Number(agent?.budgetUsed || 0),
      remaining: Number(task.maxBudget) - Number(agent?.budgetUsed || 0)
    },
    graph: {
      graphId: graph?.id ?? null,
      // Work not yet started is what a replan can still redirect. Work already
      // done stays done: it was paid for, and discarding it because a later
      // instruction arrived would charge the user twice for the same build.
      redirectableNodes: unstartedNodes.map(node => node.key),
      completedNodes: graph
        ? db.graphNodes.filter(node => node.graphId === graph.id && node.status === "succeeded").length
        : 0
    },
    risks: after.risks.filter(risk => !before.risks.includes(risk))
  };
}
