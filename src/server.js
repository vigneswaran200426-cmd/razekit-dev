import http from "node:http";
import { URL } from "node:url";
import { loadDb, transact, id } from "./store.js";
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
import { DeterministicFableAdapter, DeterministicAstraAdapter } from "./testing-model-adapters.js";
import { listModelSessions } from "./model-sessions.js";
import { readBlackboard, listContextSnapshots } from "./blackboard.js";
import { listTools, requiredScopesForTools } from "./tool-registry.js";
import {
  approvePermission,
  denyPermission,
  getAuthorizationPlan,
  getPermissions,
  listPendingRequests,
  authorizeToolCall
} from "./permission-broker.js";
import {
  registerCredentialReference,
  listCredentialReferences,
  listCredentialRequests,
  revokeCredentialReference
} from "./credential-vault.js";
import { ToolAdapterRegistry, ToolBroker } from "./tool-broker.js";
import { EchoToolAdapter } from "./testing-tool-adapters.js";
import { createRuntimeCoordinator } from "./runtime-coordinator.js";

const PORT = Number(process.env.PORT || 3000);
const runtimeCoordinator = createRuntimeCoordinator();
const modelRegistry = new ModelAdapterRegistry();

if (process.env.RAZEKIT_ENABLE_TEST_MODEL_ADAPTERS === "true") {
  modelRegistry.register("fable", new DeterministicFableAdapter());
  modelRegistry.register("astra", new DeterministicAstraAdapter());
}

const modelOrchestrator = new ModelOrchestrator({ registry: modelRegistry });
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

const page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RazeKit DEV</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1050px;margin:40px auto;padding:0 20px;background:#f5f7fa;color:#18202a}
.card{background:#fff;border:1px solid #dce3eb;border-radius:16px;padding:20px;margin:16px 0}
input,textarea,select,button{font:inherit;width:100%;box-sizing:border-box;padding:11px;margin:6px 0;border:1px solid #cbd5e1;border-radius:10px}
textarea{min-height:130px}button{background:#172033;color:#fff;border:0;cursor:pointer}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}pre{white-space:pre-wrap;word-break:break-word}
.status{padding:8px 10px;border-radius:8px;background:#eef2ff;margin:8px 0}
@media(max-width:700px){.row{grid-template-columns:1fr}}
</style></head><body>
<h1>RazeKit DEV</h1>
<p>Task creation + independent Niomi/Konami agent orchestration.</p>
<div class="card">
<h2>Create Task</h2>
<div class="row">
<div><label>Type</label><select id="type"><option value="app">App</option><option value="website">Website</option><option value="game">Game</option></select></div>
<div><label>Title</label><input id="title" placeholder="Build my product"></div>
</div>
<label>Request</label><textarea id="request"></textarea>
<label>Hard maximum budget (USD)</label><input id="budget" type="number" min="1" value="50">
<button onclick="analyze()">Run Preflight</button>
<pre id="analysis"></pre>
<button onclick="createTask()">Authorize + Create Task</button>
</div>
<div class="card"><h2>Tasks</h2><button onclick="loadTasks()">Refresh</button><pre id="tasks"></pre></div>
<div class="card"><h2>Agent Manager</h2><button onclick="loadAgents()">Refresh</button><pre id="agents"></pre></div>
<script>
let pf=null;
async function api(p,o={}){const r=await fetch(p,{headers:{"Content-Type":"application/json"},...o});const d=await r.json();if(!r.ok)throw new Error(d.error||JSON.stringify(d));return d}
async function analyze(){
  try{
    pf=await api("/api/tasks/analyze",{method:"POST",body:JSON.stringify({taskType:type.value,title:title.value,originalRequest:request.value})});
    analysis.textContent=JSON.stringify(pf,null,2);
  }catch(e){analysis.textContent=e.message}
}
async function createTask(){
  try{
    if(!pf) await analyze();
    const d=await api("/api/tasks",{method:"POST",body:JSON.stringify({
      taskType:type.value,title:title.value,originalRequest:request.value,
      specification:request.value,maxBudget:Number(budget.value),
      acceptAutonomousExecution:true,requestedTools:pf?.predictedTools||[],
      acceptanceCriteria:["Task requirements satisfied","Required build/tests pass"]
    })});
    alert("Created "+d.task.id+" -> "+d.agent.agentType);
    loadTasks();loadAgents();
  }catch(e){alert(e.message)}
}
async function loadTasks(){tasks.textContent=JSON.stringify(await api("/api/tasks"),null,2)}
async function loadAgents(){agents.textContent=JSON.stringify(await api("/internal/agents"),null,2)}
loadTasks();loadAgents();
</script></body></html>`;

const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const p = u.pathname;

    if (req.method === "GET" && p === "/health") {
      return json(res,200,{ok:true,service:"razekit-dev",time:new Date().toISOString()});
    }

    if (req.method === "GET" && p === "/") {
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      return res.end(page);
    }

    if (req.method === "POST" && p === "/api/tasks/analyze") {
      const i=await body(req);
      if(!TASK_TYPES.has(i.taskType)) return json(res,400,{error:"Invalid taskType"});
      if(!i.originalRequest?.trim()) return json(res,400,{error:"originalRequest is required"});
      return json(res,200,buildPreflight(i));
    }

    if (req.method === "POST" && p === "/api/tasks") {
      const i=await body(req);
      if(!TASK_TYPES.has(i.taskType)) return json(res,400,{error:"Invalid taskType"});
      if(!i.originalRequest?.trim()) return json(res,400,{error:"originalRequest is required"});
      if(!Number.isFinite(Number(i.maxBudget))||Number(i.maxBudget)<=0) return json(res,400,{error:"maxBudget must be greater than zero"});
      if(!i.acceptAutonomousExecution) return json(res,400,{error:"Autonomous execution authorization is required"});

      const now=new Date().toISOString();
      const pf=buildPreflight(i);
      const task={
        id:id("task"),
        userId:i.userId||"local-user",
        taskType:i.taskType,
        title:i.title||"Untitled task",
        originalRequest:i.originalRequest.trim(),
        specification:i.specification||i.originalRequest.trim(),
        requestedTools:i.requestedTools||pf.predictedTools,
        estimatedBudget:pf.estimatedBudget,
        maxBudget:Number(i.maxBudget),
        actualSpend:0,
        currency:"USD",
        status:TASK_STATUS.READY_FOR_AGENT,
        agentType:agentTypeForTask(i.taskType),
        agentInstanceId:null,
        deadline:i.deadline||null,
        authorization:{
          autonomousExecution:true,
          scopes:pf.authorizationScopes,
          toolScopes:requiredScopesForTools(i.requestedTools||pf.predictedTools),
          authorizedAt:now
        },
        createdAt:now,
        updatedAt:now
      };

      await transact(db=>{
        db.tasks.push(task);
        for(const criterion of (i.acceptanceCriteria||[])){
          db.acceptanceCriteria.push({id:id("ac"),taskId:task.id,text:String(criterion),status:"pending"});
        }
      });

      const agent=await spawnAgentForTask(task.id);
      const started=await startAgent(agent.id);
      return json(res,201,{task:await getTask(task.id),agent:started});
    }

    if (req.method === "GET" && p === "/api/tasks") {
      const db=await loadDb();
      return json(res,200,db.tasks.map(t=>({
        ...t,
        agent:t.agentInstanceId?(db.agentInstances.find(a=>a.id===t.agentInstanceId)||null):null
      })));
    }

    let m=p.match(/^\/api\/tasks\/([^/]+)$/);
    if(req.method==="GET"&&m){
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      return json(res,200,task);
    }

    if(req.method==="PATCH"&&m){
      const i=await body(req);
      return json(res,200,await transact(db=>{
        const t=db.tasks.find(x=>x.id===m[1]);
        if(!t)throw new Error("Task not found");
        for(const [key,value] of Object.entries(i)){
          if(!["id","agentInstanceId","agentType","createdAt","status"].includes(key)&&value!==undefined)t[key]=value;
        }
        t.updatedAt=new Date().toISOString();
        return t;
      }));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/authorize$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      const task=await transact(db=>{
        const t=db.tasks.find(x=>x.id===m[1]);
        if(!t)throw new Error("Task not found");
        t.authorization={
  autonomousExecution:true,
  scopes:i.scopes||t.authorization?.scopes||[],
  toolScopes:t.authorization?.toolScopes||requiredScopesForTools(t.requestedTools||[]),
  authorizedAt:new Date().toISOString()
};
        t.status=TASK_STATUS.READY_FOR_AGENT;t.updatedAt=new Date().toISOString();
        return t;
      });
      const agent=await spawnAgentForTask(task.id);
      const started=agent.status==="running"?agent:await startAgent(agent.id);
      return json(res,200,{task:await getTask(task.id),agent:started});
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if(req.method==="POST"&&m){
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
      const db=await loadDb();const t=db.tasks.find(x=>x.id===m[1]);
      if(!t)return json(res,404,{error:"Task not found"});
      const a=t.agentInstanceId?db.agentInstances.find(x=>x.id===t.agentInstanceId):null;
      return json(res,200,{
        taskId:t.id,taskStatus:t.status,agentStatus:a?.status||null,
        agentType:a?.agentType||null,budgetUsed:a?.budgetUsed??t.actualSpend,
        budgetLimit:t.maxBudget,heartbeat:a?.lastHeartbeat||null
      });
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/acceptance$/);
    if(req.method==="GET"&&m){
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      return json(res,200,await acceptanceForTask(task.id));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/acceptance\/([^/]+)$/);
    if(req.method==="PATCH"&&m){
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      const i=await body(req);
      return json(res,200,await setAcceptanceCriterion(task.id,m[2],i.status,i.evidence||null));
    }

    m=p.match(/^\/api\/tasks\/([^/]+)\/messages$/);
    if(req.method==="POST"&&m){
      const task=await getTask(m[1]);
      if(!task)return json(res,404,{error:"Task not found"});
      if(!task.agentInstanceId)return json(res,409,{error:"Task has no agent instance"});
      const i=await body(req);
      return json(res,201,await addAgentMessage(task.agentInstanceId,"user",i.content,{source:"task-dashboard"}));
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
      return json(res,200,await approvePermission(m[1],i.expiresAt||null));
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

    m=p.match(/^\/internal\/agents\/([^/]+)\/tool-calls$/);
    if(req.method==="GET"&&m){
      const agent=await getAgent(m[1]);
      if(!agent)return json(res,404,{error:"Agent not found"});
      const db=await loadDb();
      return json(res,200,db.toolCalls.filter(x=>x.agentInstanceId===m[1]));
    }

    m=p.match(/^\/internal\/credentials\/([^/]+)\/revoke$/);
    if(req.method==="POST"&&m){
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

    m=p.match(/^\/internal\/agents\/([^/]+)\/model\/step$/);
    if(req.method==="POST"&&m){
      const i=await body(req);
      return json(res,200,await modelOrchestrator.step(m[1],i));
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

server.listen(PORT, () => runtimeCoordinator.start());

function shutdown(signal) {
  runtimeCoordinator.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
  console.log("RazeKit DEV shutting down after " + signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
