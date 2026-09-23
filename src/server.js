import http from "node:http";
import { URL } from "node:url";
import { loadDb, transact, id, storeKind, assertProductionStore } from "./store.js";
import { TASK_TYPES, TASK_STATUS, agentTypeForTask, buildPreflight } from "./domain.js";
import {
  spawnAgentForTask,
  startAgent,
  heartbeatAgent,
  cancelAgent,
  listAgents,
  getAgent,
  completeAgent,
  addAgentMessage,
  processReadyTasks,
  setAcceptanceCriterion,
  acceptanceForTask
} from "./agent-manager.js";
import { checkBudget, charge } from "./budget-manager.js";
import {
  leaseWorker,
  renewWorkerLease,
  releaseWorkerLease,
  checkpointWorker,
  getWorkerRuntime,
  recoverExpiredWorkerLease
} from "./worker-runtime.js";
import { ModelAdapterRegistry } from "./model-runtime.js";
import { ModelOrchestrator } from "./model-orchestrator.js";
import { configureModelRegistry } from "./model-providers.js";
import { listModelSessions } from "./model-sessions.js";
import { readBlackboard, listContextSnapshots } from "./blackboard.js";
import { listTools, requiredScopesForTools } from "./tool-registry.js";
import { pendingUserActions, resolvePermissionAction } from "./user-actions.js";
import { analyzeChangeImpact, instructionHistory } from "./task-instructions.js";
import { taskGraphView } from "./task-graph-view.js";
import { taskControlCenter } from "./task-control.js";
import {
  EXECUTION_LEVELS,
  authorizeFromPreview,
  createTaskPreview,
  executionLevels,
  getTaskPreview,
  markPreviewConfirmed,
  narrowPreauthorizedScopes,
  predictTaskRequirements,
  estimateTaskBudget,
  validateCustomPolicy
} from "./task-lifecycle.js";
import {
  approvePermission,
  denyPermission,
  APPROVAL_SCOPE,
  getAuthorizationPlan,
  getPermissions,
  listPendingRequests,
  authorizeToolCall
} from "./permission-broker.js";
import {
  registerCredentialReference,
  listCredentialReferences,
  listCredentialRequests,
  revokeCredentialReference,
  issueTemporaryCredential,
  revokeTemporaryCredential,
  listCredentialLeases
} from "./credential-vault.js";
import { ToolAdapterRegistry, ToolBroker } from "./tool-broker.js";
import { EchoToolAdapter } from "./testing-tool-adapters.js";
import {
  createJob,
  claimNextJob,
  completeJob,
  retryJob,
  blockJob,
  listJobs,
  writeCheckpoint,
  getCheckpoint,
  recoverExpiredJobs,
  recoverExpiredWorkers,
  getCheckpoint as getDurableCheckpoint
} from "./reliability.js";
import { createRuntimeCoordinator } from "./runtime-coordinator.js";
import { advanceAgent, advanceAllAgents } from "./autonomous-loop.js";
import { verifyTask, latestVerification, verificationSummary } from "./verification.js";
import {
  buildAppWebExecutionPlan,
  executeAppWebTask,
  listAppWebRuns
} from "./app-web-executor.js";
import {
  buildGameExecutionPlan,
  executeGameTask,
  listGameRuns
} from "./game-executor.js";
import {
  taskDashboard,
  taskEvents,
  submitUserCommand,
  approveChange,
  denyChange
} from "./dashboard.js";
import { dashboardPage } from "./dashboard-page.js";
import {
  WORKER_RESOURCE_CLASS,
  RUNTIME_KIND,
  registerWorkerPool,
  registerProductionWorker,
  heartbeatProductionWorker,
  claimProductionJob,
  completeProductionJob,
  retryProductionJob,
  blockProductionJob,
  listWorkerPools,
  listProductionWorkers,
  createProductionJob,
  setWorkerPoolStatus,
  setProductionWorkerStatus
} from "./production-runtime.js";
import { createNetworkPolicy, getNetworkPolicy, assertNetworkAccess } from "./network-policy.js";
import { LocalPersistentObjectStore, persistArtifact } from "./object-storage.js";
import { recordObservabilityEvent, recordMetric, evaluateInfrastructureAlerts, resolveAlert, listAlerts, metricsSnapshot } from "./observability.js";
import { buildContainerSpec, buildMicroVMRuntimeSpec, buildGpuWorkerSpec } from "./production-runtimes.js";

import {
  principalFromHeaders,
  ensureTenant,
  assertTenantActive,
  assertTaskAccess,
  writeAudit
} from "./tenant-security.js";
import { enforceTenantLimit, enforceActiveTaskLimit } from "./abuse-controls.js";
import {
  assertAdminToken,
  tenantSecuritySummary,
  suspendTenant,
  resumeTenant,
  updateTenantLimits,
  cancelTenantTasks,
  queryAudit,
  adminRevokeCredential
} from "./admin-control.js";


const PORT = Number(process.env.PORT || 3000);
const modelRegistry = new ModelAdapterRegistry();
const modelConfiguration = configureModelRegistry(modelRegistry);

// A deployment must never boot on the process-local file store. That store does
// not fail when a second container appears — it quietly serves a different copy
// of reality, so nothing downstream can detect it. Startup is the only place
// the mistake is still visible.
if (process.env.NODE_ENV === "production") {
  assertProductionStore();
}

const modelOrchestrator = new ModelOrchestrator({ registry: modelRegistry });
const runtimeCoordinator = createRuntimeCoordinator({ orchestrator: modelOrchestrator });
const toolAdapterRegistry = new ToolAdapterRegistry();

if (process.env.RAZEKIT_ENABLE_TEST_TOOL_ADAPTERS === "true") {
  for (const tool of listTools()) toolAdapterRegistry.register(tool.key, new EchoToolAdapter());
}

const toolBroker = new ToolBroker({ registry: toolAdapterRegistry });

function json(res, status, payload) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(payload, null, 2));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const p = u.pathname;

    // Liveness is answered before identity is resolved. A load balancer, an
    // orchestrator and an uptime check all call /health anonymously, so
    // requiring a signed principal here would mark a perfectly healthy engine
    // permanently unhealthy the moment signed principals were enforced.
    if (req.method === "GET" && p === "/health") {
      return json(res,200,{
        ok:true,
        service:"razekit-dev",
        time:new Date().toISOString(),
        // Names the configured providers and models so an operator can tell a
        // deterministic deployment from a real one. Never echoes a key.
        models:modelConfiguration,
        store:storeKind()
      });
    }

    // Likewise the standalone dashboard shell: it is a static page that then
    // authenticates its own API calls.
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      return res.end(dashboardPage);
    }

    // Everything past this point is identified. When signed principals are
    // required this throws for an unsigned or forged caller.
    const principal = principalFromHeaders(req.headers);

    // Drives the autonomous loop on demand. The coordinator already ticks on a
    // timer; these exist so an integration test, or an operator watching a
    // stuck task, can step the machine deliberately instead of waiting.
    if (req.method === "POST" && p === "/internal/loop/tick") {
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      return json(res,200,await advanceAllAgents({ orchestrator: modelOrchestrator }));
    }

    const advanceMatch=p.match(/^\/internal\/agents\/([^/]+)\/advance$/);
    if(req.method==="POST"&&advanceMatch){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      const agent=await getAgent(advanceMatch[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await advanceAgent(advanceMatch[1],{ orchestrator: modelOrchestrator }));
    }

    if (req.method === "POST" && p === "/api/tasks/analyze") {
      const i=await body(req);
      if(!TASK_TYPES.has(i.taskType)) return json(res,400,{error:"Invalid taskType"});
      if(!i.originalRequest?.trim()) return json(res,400,{error:"originalRequest is required"});
      // The old shape, kept so existing callers keep working, plus the
      // prediction in the form the preview uses. Neither authorizes anything.
      return json(res,200,{
        ...buildPreflight(i),
        prediction: predictTaskRequirements(i),
        budget: estimateTaskBudget(i, { level: i.level || EXECUTION_LEVELS.MID })
      });
    }

    if (req.method === "GET" && p === "/api/execution-levels") {
      return json(res,200,{ levels: executionLevels(), tools: listTools() });
    }

    // A preview costs nothing, creates no task, spawns no agent and grants no
    // permission. It exists so that the confirmation which follows is a
    // confirmation OF something the user actually read.
    if (req.method === "POST" && p === "/api/tasks/preview") {
      const i=await body(req);
      if(!TASK_TYPES.has(i.taskType)) return json(res,400,{error:"Invalid taskType"});
      if(!i.originalRequest?.trim()) return json(res,400,{error:"originalRequest is required"});
      const level = i.level || EXECUTION_LEVELS.MID;
      if(!Object.values(EXECUTION_LEVELS).includes(level)) return json(res,400,{error:"Invalid execution level"});
      if(level===EXECUTION_LEVELS.CUSTOM){
        const check=validateCustomPolicy(i.custom||{});
        if(!check.valid) return json(res,400,{error:"Invalid custom policy",errors:check.errors});
      }
      const result=await createTaskPreview(i,{
        level,
        custom:i.custom||null,
        tenantId:principal.tenantId,
        userId:principal.userId
      });
      if(!result.ok) return json(res,400,{error:"Invalid custom policy",errors:result.errors});
      return json(res,200,result.preview);
    }

    const previewMatch=p.match(/^\/api\/tasks\/preview\/([^/]+)$/);
    if(req.method==="GET"&&previewMatch){
      const preview=await getTaskPreview(previewMatch[1],{tenantId:principal.tenantId});
      if(!preview) return json(res,404,{error:"Task preview not found"});
      return json(res,200,preview);
    }

    if (req.method === "POST" && p === "/api/tasks") {
      const i=await body(req);
      const tenant = await ensureTenant(principal.tenantId);
      assertTenantActive(tenant);
      await enforceActiveTaskLimit(principal.tenantId, principal);
      if(!TASK_TYPES.has(i.taskType)) return json(res,400,{error:"Invalid taskType"});
      if(!i.originalRequest?.trim()) return json(res,400,{error:"originalRequest is required"});
      if(!Number.isFinite(Number(i.maxBudget))||Number(i.maxBudget)<=0) return json(res,400,{error:"maxBudget must be greater than zero"});
      if(!i.acceptAutonomousExecution) return json(res,400,{error:"Autonomous execution authorization is required"});

      // A task's authorization comes from a preview the user confirmed, never
      // from this request body. Without one there is nothing the user can be
      // said to have agreed to: the old path granted every predicted scope
      // from a single boolean, which is consent to a sentence read as consent
      // to a tool list nobody was shown.
      if(!i.previewId) return json(res,400,{
        error:"A confirmed task preview is required. POST /api/tasks/preview first.",
        use:"/api/tasks/preview"
      });

      const confirmation=await authorizeFromPreview({
        previewId:i.previewId,
        fingerprint:i.previewFingerprint,
        acceptAutonomousExecution:i.acceptAutonomousExecution===true,
        maxBudget:Number(i.maxBudget),
        tenantId:principal.tenantId,
        userId:principal.userId
      });
      if(!confirmation.ok) return json(res,400,{error:"Task could not be authorized",errors:confirmation.errors});

      const now=new Date().toISOString();
      const pf=buildPreflight(i);
      const task={
        id:id("task"),
        userId:principal.userId,
        tenantId:principal.tenantId,
        taskType:i.taskType,
        title:i.title||"Untitled task",
        originalRequest:i.originalRequest.trim(),
        specification:i.specification||i.originalRequest.trim(),
        // The confirmed preview decides, not the request body: a tool added
        // between the preview and this call is exactly what the fingerprint
        // check above exists to refuse.
        requestedTools:confirmation.authorization.tools,
        estimatedBudget:confirmation.preview.budget.expected,
        executionLevel:confirmation.authorization.level,
        limits:confirmation.limits,
        maxBudget:Number(i.maxBudget),
        actualSpend:0,
        currency:"USD",
        status:TASK_STATUS.READY_FOR_AGENT,
        agentType:agentTypeForTask(i.taskType),
        agentInstanceId:null,
        deadline:i.deadline||null,
        authorization:confirmation.authorization,
        createdAt:now,
        updatedAt:now
      };

      await transact(db=>{
        db.tasks.push(task);
        for(const criterion of (i.acceptanceCriteria||[])){
          db.acceptanceCriteria.push({id:id("ac"),taskId:task.id,text:String(criterion),status:"pending"});
        }
      });

      // One agreement starts one task.
      await markPreviewConfirmed(i.previewId, task.id);

      const agent=await spawnAgentForTask(task.id);
      const started=await startAgent(agent.id);
      await writeAudit({
        tenantId: principal.tenantId,
        userId: principal.userId,
        requestId: principal.requestId,
        action: "task.create",
        resourceType: "task",
        resourceId: task.id,
        metadata: {
          taskType: task.taskType,
          agentType: task.agentType,
          executionLevel: task.executionLevel,
          previewId: i.previewId,
          previewFingerprint: confirmation.authorization.previewFingerprint
        }
      });
      return json(res,201,{
        task:await getTask(task.id),
        agent:started,
        warnings:confirmation.warnings
      });
    }

    if (req.method === "GET" && p === "/api/tasks") {
      const tenant = await ensureTenant(principal.tenantId);
      assertTenantActive(tenant);
      const db=await loadDb();
      return json(res,200,db.tasks.filter(t => (t.tenantId || "local-tenant") === principal.tenantId && t.userId === principal.userId).map(t=>({
        ...t,
        agent:t.agentInstanceId?(db.agentInstances.find(a=>a.id===t.agentInstanceId)||null):null
      })));
    }

    let m=p.match(/^\/api\/tasks\/([^/]+)$/);
    if(req.method==="GET"&&m){
      const task=await assertTaskAccess(m[1], principal);
      return json(res,200,await getTask(task.id));
    }

    if(req.method==="PATCH"&&m){
      await assertTaskAccess(m[1], principal);
      const i=await body(req);
      return json(res,200,await transact(db=>{
        const t=db.tasks.find(x=>x.id===m[1]);
        if(!t)throw new Error("Task not found");
        const mutable = new Set(["title", "specification", "deadline"]);
        for(const [key,value] of Object.entries(i)){
          if(mutable.has(key) && value!==undefined)t[key]=value;
        }
        t.updatedAt=new Date().toISOString();
        return t;
      }));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/authorize$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      const tenant = await ensureTenant(principal.tenantId);
      assertTenantActive(tenant);
      const i=await body(req);
      const existing=(await loadDb()).tasks.find(x=>x.id===m[1]);
      if(!existing) return json(res,404,{error:"Task not found"});

      // The same narrowing the preview path applies. This endpoint used to take
      // whatever scopes the body asked for, which made it a way around the rule
      // that a deployment or a data write is never pre-authorized.
      const requested=i.scopes||existing.authorization?.toolScopes||requiredScopesForTools(existing.requestedTools||[]);
      const narrowed=narrowPreauthorizedScopes(requested,existing.requestedTools||[]);

      const task=await transact(db=>{
        const t=db.tasks.find(x=>x.id===m[1]);
        if(!t)throw new Error("Task not found");
        t.authorization={
          autonomousExecution:true,
          level:t.authorization?.level||null,
          scopes:["autonomous task execution",...narrowed.granted],
          toolScopes:narrowed.granted,
          tools:t.requestedTools||[],
          neverPreauthorized:narrowed.refused.map(item=>item.scope),
          authorizedBy:principal.userId,
          authorizedAt:new Date().toISOString()
        };
        t.status=TASK_STATUS.READY_FOR_AGENT;t.updatedAt=new Date().toISOString();
        return t;
      });
      const agent=await spawnAgentForTask(task.id);
      const started=agent.status==="running"?agent:await startAgent(agent.id);
      await writeAudit({
        tenantId: principal.tenantId,
        userId: principal.userId,
        requestId: principal.requestId,
        action: "task.authorize",
        resourceType: "task",
        resourceId: task.id
      });
      return json(res,200,{task:await getTask(task.id),agent:started});
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      if(task.agentInstanceId)await cancelAgent(task.agentInstanceId,"Task cancelled by user");
      else await transact(db=>{
        const t=db.tasks.find(x=>x.id===m[1]);
        if(t){t.status=TASK_STATUS.CANCELLED;t.updatedAt=new Date().toISOString();}
      });
      return json(res,200,await getTask(m[1]));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/progress$/);
    if(req.method==="GET"&&m){
      await assertTaskAccess(m[1], principal);
      const db=await loadDb();const t=db.tasks.find(x=>x.id===m[1]);
      if(!t)return json(res,404,{error:"Task not found"});
      const a=t.agentInstanceId?db.agentInstances.find(x=>x.id===t.agentInstanceId):null;
      return json(res,200,{
        taskId:t.id,taskStatus:t.status,agentStatus:a?.status||null,
        agentType:a?.agentType||null,budgetUsed:a?.budgetUsed??t.actualSpend,
        budgetLimit:t.maxBudget,heartbeat:a?.lastHeartbeat||null
      });
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/dashboard$/);
    if(req.method==="GET"&&m){
      await assertTaskAccess(m[1], principal);
      const dashboard=await taskDashboard(m[1]);
      if(!dashboard)return json(res,404,{error:"Task not found"});
      return json(res,200,dashboard);
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/events$/);
    if(req.method==="GET"&&m){
      await assertTaskAccess(m[1], principal);
      const events=await taskEvents(m[1]);
      if(events===null)return json(res,404,{error:"Task not found"});
      return json(res,200,events);
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/commands$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      await enforceTenantLimit(principal.tenantId, "commandsPerMinute", "task.command", principal);
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      const i=await body(req);
      if(!i.content?.trim()) return json(res,400,{error:"content is required"});
      const result = await submitUserCommand(m[1],i.content);
      await writeAudit({
        tenantId: principal.tenantId,
        userId: principal.userId,
        requestId: principal.requestId,
        action: "task.command",
        resourceType: "task",
        resourceId: m[1],
        metadata: { mode: result.mode, changeId: result.change?.id || null }
      });
      return json(res,200,result);
    }

    // Everything this task is waiting on a person for. The point of the
    // endpoint is that "why has this not moved" has an answer that is not
    // "read the logs".
    // What a change would do, before anyone agrees to it. Costs nothing and
    // changes nothing; the same separation the task preview makes.
    m=p.match(/^\/api\/tasks\/([^/]+)\/changes\/impact$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      const i=await body(req);
      if(!i.content?.trim()) return json(res,400,{error:"content is required"});
      return json(res,200,await analyzeChangeImpact({taskId:m[1],content:i.content.trim()}));
    }

    // The real graph. Never a synthesised one: a diagram that does not
    // correspond to what is executing is worse than no diagram, because it is
    // believed.
    // Everything the Control Center needs, from durable records only.
    m=p.match(/^\/api\/tasks\/([^/]+)\/control$/);
    if(req.method==="GET"&&m){
      const task=await assertTaskAccess(m[1], principal);
      const view=await taskControlCenter({taskId:m[1],tenantId:task.tenantId||principal.tenantId});
      if(!view) return json(res,404,{error:"Task not found"});
      return json(res,200,view);
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/graph$/);
    if(req.method==="GET"&&m){
      const task=await assertTaskAccess(m[1], principal);
      const view=await taskGraphView({taskId:m[1],tenantId:task.tenantId||principal.tenantId});
      if(!view) return json(res,404,{error:"This task has no execution graph yet"});
      return json(res,200,view);
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/instructions$/);
    if(req.method==="GET"&&m){
      await assertTaskAccess(m[1], principal);
      return json(res,200,{versions:await instructionHistory(m[1])});
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/actions$/);
    if(req.method==="GET"&&m){
      await assertTaskAccess(m[1], principal);
      return json(res,200,{actions:await pendingUserActions({taskId:m[1],tenantId:principal.tenantId})});
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/actions\/([^/]+)$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      const i=await body(req);
      if(typeof i.approve!=="boolean"){
        return json(res,400,{error:"approve must be true or false. Not answering is not an answer."});
      }
      const scope=i.scope||APPROVAL_SCOPE.ONCE;
      if(!Object.values(APPROVAL_SCOPE).includes(scope)){
        return json(res,400,{error:"Unknown approval scope: "+scope});
      }
      try{
        const result=await resolvePermissionAction({
          requestId:m[2],
          approve:i.approve,
          scope,
          expiresAt:i.expiresAt||null,
          reason:i.reason||null,
          actedBy:principal.userId
        });
        return json(res,200,result);
      }catch(error){
        return json(res,404,{error:error.message});
      }
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/changes\/([^/]+)\/approve$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      const i=await body(req);
      return json(res,200,await approveChange(m[1],m[2],{maxBudget:i.maxBudget??null}));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/changes\/([^/]+)\/deny$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      const i=await body(req);
      return json(res,200,await denyChange(m[1],m[2],i.reason||"User declined the requested change"));
    }


    m=p.match(/^\/api\/tasks\/([^/]+)\/acceptance$/);
    if(req.method==="GET"&&m){
      await assertTaskAccess(m[1], principal);
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      return json(res,200,await acceptanceForTask(task.id));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/acceptance\/([^/]+)$/);
    if(req.method==="PATCH"&&m){
      await assertTaskAccess(m[1], principal);
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      const i=await body(req);
      return json(res,200,await setAcceptanceCriterion(task.id,m[2],i.status,i.evidence||null));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/messages$/);
    if(req.method==="POST"&&m){
      await assertTaskAccess(m[1], principal);
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      if(!task.agentInstanceId)return json(res,409,{error:"Task has no agent instance"});
      const i=await body(req);
      return json(res,201,await addAgentMessage(task.agentInstanceId,"user",i.content,{source:"task-dashboard"}));
    }


    if(req.url && p.startsWith("/internal/admin/")){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
    }

    m=p.match(/^\/internal\/admin\/tenants\/([^/]+)\/security$/);
    if(req.method==="GET"&&m){
      return json(res,200,await tenantSecuritySummary(m[1]));
    }

    m=p.match(/^\/internal\/admin\/tenants\/([^/]+)\/suspend$/);
    if(req.method==="POST"&&m){
      return json(res,200,await suspendTenant(m[1],"admin"));
    }

    m=p.match(/^\/internal\/admin\/tenants\/([^/]+)\/resume$/);
    if(req.method==="POST"&&m){
      return json(res,200,await resumeTenant(m[1],"admin"));
    }

    m=p.match(/^\/internal\/admin\/tenants\/([^/]+)\/limits$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await updateTenantLimits(m[1],i.limits||i,"admin"));
    }

    m=p.match(/^\/internal\/admin\/tenants\/([^/]+)\/cancel-tasks$/);
    if(req.method==="POST"&&m){
      return json(res,200,await cancelTenantTasks(m[1],"admin"));
    }

    m=p.match(/^\/internal\/admin\/credentials\/([^/]+)\/revoke$/);
    if(req.method==="POST"&&m){
      return json(res,200,await adminRevokeCredential(m[1],"admin"));
    }


    if(req.method==="GET"&&p==="/internal/admin/audit"){
      return json(res,200,await queryAudit({
        tenantId:u.searchParams.get("tenantId")||null,
        action:u.searchParams.get("action")||null,
        limit:u.searchParams.get("limit")||100
      }));
    }

    if(req.method==="GET"&&p==="/internal/infrastructure/status"){
      const pools=await listWorkerPools();
      const workers=await listProductionWorkers();
      const metrics=await metricsSnapshot({persist:false});
      const alerts=await evaluateInfrastructureAlerts();
      return json(res,200,{pools,workers,metrics,alerts});
    }

    if(req.method==="POST"&&p==="/internal/infrastructure/pools"){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      const i=await body(req);
      return json(res,201,await registerWorkerPool(i));
    }
    m=p.match(/^\/internal\/infrastructure\/pools\/([^/]+)\/status$/);
    if(req.method==="POST"&&m){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      const i=await body(req);
      return json(res,200,await setWorkerPoolStatus(m[1],i.status));
    }

    m=p.match(/^\/internal\/infrastructure\/workers\/([^/]+)\/status$/);
    if(req.method==="POST"&&m){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      const i=await body(req);
      return json(res,200,await setProductionWorkerStatus(m[1],i.status));
    }



    if(req.method==="POST"&&p==="/internal/infrastructure/workers/register"){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      const i=await body(req);
      return json(res,201,await registerProductionWorker(i));
    }

    m=p.match(/^\/internal\/infrastructure\/workers\/([^/]+)\/heartbeat$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await heartbeatProductionWorker(m[1],i));
    }

    m=p.match(/^\/internal\/infrastructure\/pools\/([^/]+)\/jobs\/claim$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await claimProductionJob(m[1],i.ownerId,i.leaseMs));
    }

    m=p.match(/^\/internal\/infrastructure\/workers\/([^/]+)\/job\/complete$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await completeProductionJob(m[1],i.result||null));
    }

    m=p.match(/^\/internal\/infrastructure\/workers\/([^/]+)\/job\/retry$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await retryProductionJob(m[1],i.error,i.delayMs));
    }

    m=p.match(/^\/internal\/infrastructure\/workers\/([^/]+)\/job\/block$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await blockProductionJob(m[1],i.reason));
    }

    if(req.method==="POST"&&p==="/internal/infrastructure/jobs"){
      const i=await body(req);
      return json(res,201,await createProductionJob(i));
    }

    if(req.method==="POST"&&p==="/internal/infrastructure/network-policies"){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      const i=await body(req);
      return json(res,201,await createNetworkPolicy(i));
    }

    m=p.match(/^\/internal\/infrastructure\/network-policies\/([^/]+)\/check$/);
    if(req.method==="POST"&&m){
      const policy=await getNetworkPolicy(m[1]);
      if(!policy)return json(res,404,{error:"Network policy not found"});
      const i=await body(req);
      return json(res,200,assertNetworkAccess(policy,i.target));
    }

    if(req.method==="POST"&&p==="/internal/infrastructure/artifacts"){
      const i=await body(req);
      const store=new LocalPersistentObjectStore();
      const value=i.encoding==="base64" ? Buffer.from(String(i.value||""),"base64") : String(i.value||"");
      return json(res,201,await persistArtifact({
        store,
        tenantId:i.tenantId||principal.tenantId,
        taskId:i.taskId,
        artifactType:i.artifactType,
        objectKey:i.objectKey,
        value,
        metadata:i.metadata||{}
      }));
    }

    if(req.method==="GET"&&p==="/internal/infrastructure/metrics"){
      return json(res,200,await metricsSnapshot());
    }

    if(req.method==="GET"&&p==="/internal/infrastructure/alerts"){
      return json(res,200,await listAlerts({
        status:u.searchParams.get("status")||null,
        severity:u.searchParams.get("severity")||null
      }));
    }

    m=p.match(/^\/internal\/infrastructure\/alerts\/([^/]+)\/resolve$/);
    if(req.method==="POST"&&m){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      return json(res,200,await resolveAlert(m[1]));
    }

    if(req.method==="POST"&&p==="/internal/infrastructure/runtime/container/spec"){
      const i=await body(req);
      return json(res,200,buildContainerSpec(i));
    }

    if(req.method==="POST"&&p==="/internal/infrastructure/runtime/microvm/spec"){
      const i=await body(req);
      return json(res,200,buildMicroVMRuntimeSpec(i));
    }

    if(req.method==="POST"&&p==="/internal/infrastructure/runtime/gpu/spec"){
      const i=await body(req);
      return json(res,200,buildGpuWorkerSpec(i));
    }

    if(req.method==="POST"&&p==="/internal/jobs"){
      const i=await body(req);
      return json(res,201,await createJob(i));
    }

    if(req.method==="POST"&&p==="/internal/jobs/claim"){
      const i=await body(req);
      return json(res,200,await claimNextJob(i.ownerId,i.leaseMs,{
        agentInstanceId:i.agentInstanceId||null,
        taskId:i.taskId||null,
        kind:i.kind||null
      }));
    }

    m=p.match(/^\/internal\/jobs\/([^/]+)\/complete$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await completeJob(m[1],i.leaseId,i.result??null));
    }

    m=p.match(/^\/internal\/jobs\/([^/]+)\/retry$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await retryJob(m[1],i.leaseId,i.error,i.delayMs));
    }

    m=p.match(/^\/internal\/jobs\/([^/]+)\/block$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await blockJob(m[1],i.leaseId,i.reason));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/jobs$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await listJobs(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/checkpoints$/);
    if(req.method==="POST"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const i=await body(req);
      return json(res,201,await writeCheckpoint({
        agentInstanceId:m[1],
        taskId:agent.taskId,
        kind:i.kind,
        scopeId:i.scopeId||null
      },i.checkpoint,i.metadata||{}));
    }

    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const kind=u.searchParams.get("kind");
      if(!kind)return json(res,400,{error:"kind query parameter is required"});
      return json(res,200,await getDurableCheckpoint(m[1],kind,u.searchParams.get("scopeId")));
    }

    if(req.method==="POST"&&p==="/internal/recovery/run"){
      const workers=await recoverExpiredWorkers();
      const jobs=await recoverExpiredJobs();
      return json(res,200,{workers,jobs});
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/app-web\/plan$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await buildAppWebExecutionPlan(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/app-web\/execute$/);
    if(req.method==="POST"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const i=await body(req);
      const workspace=await loadDb().then(db=>db.workspaces.find(x=>x.id===agent.workspaceId));
      if(!workspace)return json(res,409,{error:"Agent workspace not found"});
      return json(res,202,await executeAppWebTask({
        agentInstanceId:m[1],
        workspaceRoot:workspace.path,
        plan:i.plan||null
      }));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/app-web\/runs$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await listAppWebRuns(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/game\/plan$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await buildGameExecutionPlan(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/game\/execute$/);
    if(req.method==="POST"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const i=await body(req);
      const db=await loadDb();
      const workspace=db.workspaces.find(x=>x.id===agent.workspaceId);
      if(!workspace)return json(res,409,{error:"Agent workspace not found"});
      return json(res,202,await executeGameTask({
        agentInstanceId:m[1],
        workspaceRoot:workspace.path,
        plan:i.plan||null
      }));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/game\/runs$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await listGameRuns(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/verification$/);
    if(req.method==="POST"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const i=await body(req);
      return json(res,200,await verifyTask(m[1],{
        requireArtifact:i.requireArtifact !== false
      }));
    }

    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,verificationSummary(await latestVerification(m[1])));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/verification\/latest$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await latestVerification(m[1]));
    }

    if(req.method==="GET"&&p==="/internal/tools"){
      return json(res,200,listTools());
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/permissions$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await getAuthorizationPlan(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/permissions\/pending$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await listPendingRequests(m[1]));
    }

    m=p.match(/^\/internal\/permissions\/([^/]+)\/approve$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      // Defaults to ONCE like every other path: an operator approving on a
      // user's behalf should not grant more than the user would have.
      return json(res,200,await approvePermission(m[1],{
        scope:i.scope||APPROVAL_SCOPE.ONCE,
        expiresAt:i.expiresAt||null,
        approvedBy:"operator"
      }));
    }

    m=p.match(/^\/internal\/permissions\/([^/]+)\/deny$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await denyPermission(m[1],i.reason));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/credentials$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await listCredentialReferences(m[1]));
    }

    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,201,await registerCredentialReference(m[1],i));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/credentials\/requests$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await listCredentialRequests(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/credentials\/([^/]+)\/lease$/);
    if(req.method==="POST"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const i=await body(req);
      return json(res,201,await issueTemporaryCredential(m[1],m[2],{
        scopes:i.scopes||[],
        ttlMs:i.ttlMs
      }));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/credential-leases$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      return json(res,200,await listCredentialLeases(m[1]));
    }

    m=p.match(/^\/internal\/credentials\/leases\/([^/]+)\/revoke$/);
    if(req.method==="POST"&&m){
      return json(res,200,await revokeTemporaryCredential(m[1]));
    }


    m=p.match(/^\/internal\/agents\/([^/]+)\/tool-calls$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const db=await loadDb();
      return json(res,200,db.toolCalls.filter(x=>x.agentInstanceId===m[1]));
    }

    m=p.match(/^\/internal\/credentials\/([^/]+)\/revoke$/);
    if(req.method==="POST"&&m){
      assertAdminToken(req.headers["x-razekit-admin-token"]);
      return json(res,200,await revokeCredentialReference(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/tools\/invoke$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await toolBroker.invoke({
        agentInstanceId:m[1],
        toolKey:i.toolKey,
        input:i.input||{},
        scopes:i.scopes||[],
        credentialProvider:i.credentialProvider||null
      }));
    }

    if(req.method==="POST"&&p==="/internal/agents/process-ready"){
      return json(res,200,await processReadyTasks());
    }

    if(req.method==="GET"&&p==="/internal/agents"){
      return json(res,200,await listAgents());
    }

    if(req.method==="POST"&&p==="/internal/agents/spawn"){
      const i=await body(req);
      return json(res,201,await spawnAgentForTask(i.taskId));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)$/);
    if(req.method==="GET"&&m){
      const a=await getAgent(m[1]);
      if(!a)return json(res,404,{error:"Agent not found"});
      return json(res,200,a);
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/start$/);
    if(req.method==="POST"&&m)return json(res,200,await startAgent(m[1]));

    m=p.match(/^\/internal\/agents\/([^/]+)\/heartbeat$/);
    if(req.method==="POST"&&m){const i=await body(req);return json(res,200,await heartbeatAgent(m[1],i));}

    m=p.match(/^\/internal\/agents\/([^/]+)\/messages$/);
    if(req.method==="GET"&&m){
      const a=await getAgent(m[1]);
      if(!a)return json(res,404,{error:"Agent not found"});
      return json(res,200,a.messages);
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/cancel$/);
    if(req.method==="POST"&&m){const i=await body(req);return json(res,200,await cancelAgent(m[1],i.reason));}

    m=p.match(/^\/internal\/agents\/([^/]+)\/complete$/);
    if(req.method==="POST"&&m){const i=await body(req);return json(res,200,await completeAgent(m[1],i.resultSummary));}

    m=p.match(/^\/internal\/agents\/([^/]+)\/model\/provision$/);
    if(req.method==="POST"&&m){
      return json(res,200,await modelOrchestrator.provision(m[1]));
    }

    // /model/step is deliberately gone. It ran a model phase outside the graph:
    // no node, no lease, no reservation, and spend recorded after the provider
    // had already been paid. Everything it did now happens as a graph node, so
    // the way to advance a task is to advance the task.
    m=p.match(/^\/internal\/agents\/([^/]+)\/model\/step$/);
    if(req.method==="POST"&&m){
      return json(res,410,{
        error:"Model phases run as graph nodes. Advance the task instead.",
        use:"/internal/agents/"+m[1]+"/advance"
      });
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/model\/state$/);
    if(req.method==="GET"&&m){
      const state=await modelOrchestrator.getState(m[1]);
      if(!state.run)return json(res,404,{error:"Model orchestration state not found"});
      return json(res,200,state);
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/model\/sessions$/);
    if(req.method==="GET"&&m){
      return json(res,200,await listModelSessions(m[1]));
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/model\/blackboard$/);
    if(req.method==="GET"&&m){
      return json(res,200,{
        entries:await readBlackboard(m[1]),
        snapshots:await listContextSnapshots(m[1])
      });
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/spend-check$/);
    if(req.method==="POST"&&m){const i=await body(req);return json(res,200,await checkBudget(m[1],i.amount));}

    m=p.match(/^\/internal\/agents\/([^/]+)\/charge$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await charge(m[1],i.amount,i.reason));
    }

    m=p.match(/^\/internal\/workers\/([^/]+)\/lease$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await leaseWorker(m[1],i.ownerId,i.leaseMs));
    }

    m=p.match(/^\/internal\/workers\/([^/]+)\/lease\/renew$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await renewWorkerLease(m[1],i.leaseId,i.leaseMs));
    }

    m=p.match(/^\/internal\/workers\/([^/]+)\/lease\/release$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await releaseWorkerLease(m[1],i.leaseId,i.finalState));
    }

    m=p.match(/^\/internal\/workers\/([^/]+)\/checkpoint$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await checkpointWorker(m[1],i.leaseId,i.checkpoint));
    }

    m=p.match(/^\/internal\/workers\/([^/]+)\/recover$/);
    if(req.method==="POST"&&m){
      return json(res,200,await recoverExpiredWorkerLease(m[1]));
    }

    m=p.match(/^\/internal\/workers\/([^/]+)\/runtime$/);
    if(req.method==="GET"&&m){
      const runtime=await getWorkerRuntime(m[1]);
      if(!runtime)return json(res,404,{error:"Worker not found"});
      return json(res,200,runtime);
    }

    m=p.match(/^\/internal\/agents\/([^/]+)\/workspace$/);
    if(req.method==="GET"&&m){
      const a=await getAgent(m[1]);
      if(!a)return json(res,404,{error:"Agent not found"});
      return json(res,200,a.workspace);
    }

    return json(res,404,{error:"Not found"});
  } catch(e) {
    return json(res,400,{error:e.message||"Unexpected error"});
  }
});

function getTask(taskId){
  return loadDb().then(db=>{
    const t=db.tasks.find(x=>x.id===taskId);
    if(!t)return null;
    return {
      ...t,
      acceptanceCriteria:db.acceptanceCriteria.filter(x=>x.taskId===taskId),
      agent:t.agentInstanceId?(db.agentInstances.find(a=>a.id===t.agentInstanceId)||null):null
    };
  });
}

// The coordinator is what ticks tasks forward. It runs by default, because an
// engine that accepts tasks and never advances them is a silent hang — but a
// deployment that runs a separate scheduler, or one that only serves the API
// while workers do the work, turns it off here rather than by not deploying it.
const COORDINATOR_ENABLED = String(process.env.RAZEKIT_COORDINATOR_ENABLED ?? "true").toLowerCase() !== "false";

server.listen(PORT, () => {
  if (COORDINATOR_ENABLED) runtimeCoordinator.start();
});

function shutdown(signal) {
  runtimeCoordinator.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
  console.log("RazeKit DEV shutting down after " + signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
