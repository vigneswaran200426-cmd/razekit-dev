import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// What a task is waiting on a person for.
//
// Two things are asserted here and they pull in opposite directions, which is
// why both matter. An approval must be narrow — the default is a single use,
// because one yes to one file write is not consent to every later write. And a
// task that is waiting must be able to SAY so in one place, because a task that
// is blocked and silent is indistinguishable from one that is broken.

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-actions-data-"));
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "razekit-actions-ws-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_WORKSPACE_ROOT = workspaceDir;
process.env.RAZEKIT_STORE = "json";

const { transact, loadDb, id } = await import("../src/store.js");
const { TASK_STATUS, AGENT_TYPES, AGENT_STATUS } = await import("../src/domain.js");
const { spawnAgentForTask, startAgent, getAgent } = await import("../src/agent-manager.js");
const { ensureTenant } = await import("../src/tenant-security.js");
const { APPROVAL_SCOPE, authorizeToolCall } = await import("../src/permission-broker.js");
const { createTaskGraph } = await import("../src/jev.js");
const {
  USER_ACTION_KIND,
  USER_ACTION_URGENCY,
  pendingUserActions,
  resolvePermissionAction
} = await import("../src/user-actions.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

let seq = 0;
async function makeAgent({ toolScopes = ["workspace:read", "workspace:write"] } = {}) {
  seq += 1;
  const tenantId = "tenant-actions-" + seq;
  await ensureTenant(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: id("task"),
    tenantId,
    userId: "actions-user",
    taskType: "website",
    title: "Actions " + seq,
    originalRequest: "Build and deploy",
    specification: "Build and deploy",
    requestedTools: ["filesystem", "deploy-web"],
    estimatedBudget: 1,
    maxBudget: 20,
    actualSpend: 0,
    currency: "USD",
    status: TASK_STATUS.READY_FOR_AGENT,
    agentType: AGENT_TYPES.NIOMI,
    agentInstanceId: null,
    authorization: {
      autonomousExecution: true,
      scopes: ["autonomous task execution"],
      toolScopes,
      authorizedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  await transact(db => db.tasks.push(task));
  const agent = await spawnAgentForTask(task.id);
  await startAgent(agent.id);
  return { task, agent, tenantId };
}

test("an approval is a single use unless the user says otherwise", async () => {
  const { agent } = await makeAgent();

  const first = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);
  assert.equal(first.allowed, false, "a deployment was allowed without anyone approving it");
  assert.ok(first.permissionRequest);

  // No scope given: the narrowest one applies.
  const resolved = await resolvePermissionAction({
    requestId: first.permissionRequest.id,
    approve: true,
    actedBy: "user:test"
  });
  assert.equal(resolved.approved, true);

  const second = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);
  assert.equal(second.allowed, true, "the approval was not honoured at all");
  assert.equal(second.consumedGrants.length, 1);
  assert.equal(second.consumedGrants[0].scope, APPROVAL_SCOPE.ONCE);

  // Spent. The second deployment is a new question.
  const third = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);
  assert.equal(third.allowed, false, "one approval authorized a second deployment");
});

test("an approval for one step does not carry to another", async () => {
  const { agent, task, tenantId } = await makeAgent();

  const created = await createTaskGraph({
    tenantId,
    userId: task.userId,
    taskId: task.id,
    agentInstanceId: agent.id,
    nodes: [
      { key: "a", kind: "command", dependsOn: [], payload: {}, toolScopes: [] },
      { key: "b", kind: "command", dependsOn: [], payload: {}, toolScopes: [] }
    ]
  });
  const [nodeA, nodeB] = created.nodes;

  const asked = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"], { nodeId: nodeA.id });
  await resolvePermissionAction({
    requestId: asked.permissionRequest.id,
    approve: true,
    scope: APPROVAL_SCOPE.NODE,
    actedBy: "user:test"
  });

  // The step it was granted for may do it, repeatedly: the user approved the
  // step, not a single call within it.
  const againOnA = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"], { nodeId: nodeA.id });
  assert.equal(againOnA.allowed, true);
  const thirdOnA = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"], { nodeId: nodeA.id });
  assert.equal(thirdOnA.allowed, true);

  // A different step is a different question.
  const onB = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"], { nodeId: nodeB.id });
  assert.equal(onB.allowed, false, "a step-scoped approval leaked to another step");
});

test("a task-wide approval widens the task's standing authorization, and only that scope does", async () => {
  const { agent } = await makeAgent();

  const asked = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);
  await resolvePermissionAction({
    requestId: asked.permissionRequest.id,
    approve: true,
    scope: APPROVAL_SCOPE.TASK,
    actedBy: "user:test"
  });

  for (let i = 0; i < 3; i += 1) {
    const result = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);
    assert.equal(result.allowed, true, "a task-wide approval did not hold");
  }

  const db = await loadDb();
  const permission = db.toolPermissions.find(item => item.agentInstanceId === agent.id);
  assert.ok(permission.grantedScopes.includes("deployment:deploy"));
});

test("a denial is an answer, not a silence", async () => {
  const { agent } = await makeAgent();
  const asked = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);

  const resolved = await resolvePermissionAction({
    requestId: asked.permissionRequest.id,
    approve: false,
    reason: "Not deploying this yet",
    actedBy: "user:test"
  });

  assert.equal(resolved.approved, false);
  assert.equal(resolved.request.status, "denied");
  assert.equal(resolved.request.reason, "Not deploying this yet");

  const pending = await pendingUserActions({ agentInstanceId: agent.id });
  assert.equal(
    pending.filter(action => action.kind === USER_ACTION_KIND.PERMISSION).length, 0,
    "a denied request is still being asked about"
  );
});

test("approving reopens the step that was refused, so the task carries on", async () => {
  const { agent, task, tenantId } = await makeAgent();
  const created = await createTaskGraph({
    tenantId,
    userId: task.userId,
    taskId: task.id,
    agentInstanceId: agent.id,
    nodes: [{ key: "deploy", kind: "deploy", dependsOn: [], payload: {}, toolScopes: [] }]
  });
  const node = created.nodes[0];

  // The step ran, was refused, and failed — which is where it would sit forever
  // if approving changed nothing it could see.
  await transact(db => {
    const item = db.graphNodes.find(x => x.id === node.id);
    item.status = "failed";
    item.attempt = 1;
    item.error = { message: "Permission required: deployment:deploy" };
    item.finishedAt = new Date().toISOString();
  });

  const asked = await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"], { nodeId: node.id });
  const resolved = await resolvePermissionAction({
    requestId: asked.permissionRequest.id,
    approve: true,
    scope: APPROVAL_SCOPE.NODE,
    actedBy: "user:test"
  });

  assert.equal(resolved.reopened?.accepted, true, "the refused step was not reopened");
  assert.ok(["ready", "pending"].includes(resolved.reopened.node.status));
  assert.equal(resolved.resumed, true, "the task was left waiting after its blocker was cleared");

  const current = await getAgent(agent.id);
  assert.equal(current.status, AGENT_STATUS.RUNNING);
});

test("everything a task waits on appears in one list, blocking first", async () => {
  const { agent, task } = await makeAgent();

  await authorizeToolCall(agent.id, "deploy-web", ["deployment:deploy"]);

  // An advisory item, raised earlier than the blocking one, to prove the order
  // is by urgency rather than by time.
  await transact(db => {
    db.taskChangeRequests.push({
      id: id("change"),
      taskId: task.id,
      agentInstanceId: agent.id,
      content: "Use a different colour scheme",
      reason: "This change alters the agreed design",
      status: "pending",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      resolvedAt: null
    });
  });

  const actions = await pendingUserActions({ taskId: task.id });

  assert.ok(actions.length >= 2);
  assert.equal(actions[0].urgency, USER_ACTION_URGENCY.BLOCKING, "an advisory item buried the blocker");
  assert.equal(actions[0].kind, USER_ACTION_KIND.PERMISSION);
  assert.ok(actions.some(action => action.kind === USER_ACTION_KIND.DECISION));

  // Every item says what it is and what answering it would mean.
  for (const action of actions) {
    assert.ok(action.title.length > 0);
    assert.ok(action.detail.length > 0);
    assert.ok(action.taskId);
  }

  // The narrow choice is offered first.
  const permission = actions.find(action => action.kind === USER_ACTION_KIND.PERMISSION);
  assert.equal(permission.choices[0].value, APPROVAL_SCOPE.ONCE);
});

test("one tenant cannot see another's pending actions", async () => {
  const mine = await makeAgent();
  const theirs = await makeAgent();

  await authorizeToolCall(theirs.agent.id, "deploy-web", ["deployment:deploy"]);

  const visible = await pendingUserActions({ tenantId: mine.tenantId });
  assert.equal(
    visible.filter(action => action.agentInstanceId === theirs.agent.id).length, 0,
    "a pending action leaked across tenants"
  );
});
