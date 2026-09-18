import http from "node:http";
import { URL } from "node:url";
import { loadDb, transact, id } from "./store.js";
import { TASK_TYPES, TASK_STATUS, agentTypeForTask, buildPreflight } from "./domain.js";
import { spawnAgentForTask, startAgent, heartbeatAgent, cancelAgent, listAgents, getAgent, completeAgent } from "./agent-manager.js";

const PORT = Number(process.env.PORT || 3000);

function json(res, status, payload) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(payload, null, 2));
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
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
@media(max-width:700px){.row{grid-template-columns:1fr}}
</style></head><body>
<h1>RazeKit DEV</h1>
<p>Phase 1 task creation + Phase 2 independent Niomi/Konami Agent Manager.</p>
<div class="card">
<h2>Create Task</h2>
<div class="row"><div><label>Type</label><select id="type"><option value="app">App</option><option value="website">Website</option><option value="game">Game</option></select></div>
<div><label>Title</label><input id="title" placeholder="Build my product"></div></div>
<label>Request</label><textarea id="request"></textarea>
<label>Maximum budget (USD)</label><input id="budget" type="number" min="1" value="50">
<button onclick="analyze()">Run Preflight</button><pre id="analysis"></pre>
<button onclick="createTask()">Create Authorized Task</button>
</div>
<div class="card"><h2>Tasks</h2><button onclick="loadTasks()">Refresh</button><pre id="tasks"></pre></div>
<div class="card"><h2>Agent Manager</h2><button onclick="loadAgents()">Refresh</button><pre id="agents"></pre></div>
<script>
let pf=null;
async function api(p,o={}){const r=await fetch(p,{headers:{'Content-Type':'application/json'},...o});const d=await r.json();if(!r.ok)throw new Error(d.error||JSON.stringify(d));return d}
async function analyze(){try{pf=await api('/api/tasks/analyze',{method:'POST',body:JSON.stringify({taskType:type.value,title:title.value,originalRequest:request.value})});analysis.textContent=JSON.stringify(pf,null,2)}catch(e){analysis.textContent=e.message}}
async function createTask(){try{const d=await api('/api/tasks',{method:'POST',body:JSON.stringify({taskType:type.value,title:title.value,originalRequest:request.value,specification:request.value,maxBudget:Number(budget.value),acceptAutonomousExecution:true,requestedTools:pf?.predictedTools||[]})});alert('Created '+d.id);loadTasks()}catch(e){alert(e.message)}}
async function loadTasks(){tasks.textContent=JSON.stringify(await api('/api/tasks'),null,2)}
async function loadAgents(){agents.textContent=JSON.stringify(await api('/internal/agents'),null,2)}
loadTasks();loadAgents();
</script></body></html>`;

const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const p = u.pathname;

    if (req.method === "GET" && p === "/") {
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      return res.end(page);
    }

    if (req.method === "POST" && p === "/api/tasks/analyze") {
      const i = await body(req);
      if (!TASK_TYPES.has(i.taskType)) return json(res,400,{error:"Invalid taskType"});
      return json(res,200,buildPreflight({taskType:i.taskType,title:i.title||"",originalRequest:i.originalRequest||"",specification:i.specification||""}));
    }

    if (req.method === "POST" && p === "/api/tasks") {
      const i = await body(req);
      if (!TASK_TYPES.has(i.taskType)) return json(res,400,{error:"Invalid taskType"});
      if (!i.originalRequest?.trim()) return json(res,400,{error:"originalRequest is required"});
      if (!Number.isFinite(Number(i.maxBudget)) || Number(i.maxBudget) <= 0) return json(res,400,{error:"maxBudget must be greater than zero"});
      if (!i.acceptAutonomousExecution) return json(res,400,{error:"Autonomous execution authorization is required"});

      const now = new Date().toISOString();
      const pf = buildPreflight(i);
      const task = {
        id:id("task"),
        userId:i.userId||"local-user",
        taskType:i.taskType,
        title:i.title||"Untitled task",
        originalRequest:i.originalRequest.trim(),
        specification:i.specification||i.originalRequest.trim(),
        requestedTools:i.requestedTools||[],
        estimatedBudget:pf.estimatedBudget,
        maxBudget:Number(i.maxBudget),
        actualSpend:0,
        currency:"USD",
        status:TASK_STATUS.READY_FOR_AGENT,
        agentType:agentTypeForTask(i.taskType),
        agentInstanceId:null,
        deadline:i.deadline||null,
        authorization:{autonomousExecution:true,scopes:pf.authorizationScopes,authorizedAt:now},
        createdAt:now,
        updatedAt:now
      };

      await transact(db => {
        db.tasks.push(task);
        for (const criterion of (i.acceptanceCriteria||[])) {
          db.acceptanceCriteria.push({id:id("ac"),taskId:task.id,text:String(criterion),status:"pending"});
        }
      });
      return json(res,201,task);
    }

    if (req.method === "GET" && p === "/api/tasks") {
      const db = await loadDb();
      return json(res,200,db.tasks.map(t => ({...t,agent:t.agentInstanceId ? (db.agentInstances.find(a=>a.id===t.agentInstanceId)||null) : null})));
    }

    let m = p.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const db = await loadDb();
      const t = db.tasks.find(x=>x.id===m[1]);
      if (!t) return json(res,404,{error:"Task not found"});
      return json(res,200,t);
    }

    if (req.method === "PATCH" && m) {
      const i = await body(req);
      return json(res,200,await transact(db => {
        const t = db.tasks.find(x=>x.id===m[1]);
        if (!t) throw new Error("Task not found");
        for (const [key,value] of Object.entries(i)) {
          if (!["id","agentInstanceId","agentType","createdAt"].includes(key) && value !== undefined) t[key]=value;
        }
        t.updatedAt = new Date().toISOString();
        return t;
      }));
    }

    m = p.match(/^\/api\/tasks\/([^/]+)\/authorize$/);
    if (req.method === "POST" && m) {
      const i=await body(req);
      return json(res,200,await transact(db => {
        const t=db.tasks.find(x=>x.id===m[1]);
        if(!t) throw new Error("Task not found");
        t.authorization={autonomousExecution:true,scopes:i.scopes||t.authorization?.scopes||[],authorizedAt:new Date().toISOString()};
        t.status=TASK_STATUS.READY_FOR_AGENT;
        t.updatedAt=new Date().toISOString();
        return t;
      }));
    }

    m = p.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (req.method === "POST" && m) {
      const t=await transact(db=>{
        const x=db.tasks.find(x=>x.id===m[1]);
        if(!x) throw new Error("Task not found");
        x.status=TASK_STATUS.CANCELLED;x.updatedAt=new Date().toISOString();return x;
      });
      if(t.agentInstanceId) try { await cancelAgent(t.agentInstanceId,"Task cancelled by user"); } catch {}
      return json(res,200,t);
    }

    m = p.match(/^\/api\/tasks\/([^/]+)\/progress$/);
    if (req.method === "GET" && m) {
      const db=await loadDb(); const t=db.tasks.find(x=>x.id===m[1]);
      if(!t) return json(res,404,{error:"Task not found"});
      const a=t.agentInstanceId?db.agentInstances.find(x=>x.id===t.agentInstanceId):null;
      return json(res,200,{taskId:t.id,taskStatus:t.status,agentStatus:a?.status||null,agentType:a?.agentType||null,budgetUsed:a?.budgetUsed??t.actualSpend,budgetLimit:t.maxBudget,heartbeat:a?.lastHeartbeat||null});
    }

    if (req.method === "GET" && m && false) {}

    if (req.method === "POST" && p === "/internal/agents/spawn") {
      const i=await body(req); return json(res,201,await spawnAgentForTask(i.taskId));
    }
    if (req.method === "GET" && p === "/internal/agents") return json(res,200,await listAgents());

    m=p.match(/^\/internal\/agents\/([^/]+)$/);
    if(req.method==="GET"&&m){const a=await getAgent(m[1]);if(!a)return json(res,404,{error:"Agent not found"});return json(res,200,a);}

    m=p.match(/^\/internal\/agents\/([^/]+)\/start$/);
    if(req.method==="POST"&&m) return json(res,200,await startAgent(m[1]));

    m=p.match(/^\/internal\/agents\/([^/]+)\/heartbeat$/);
    if(req.method==="POST"&&m){const i=await body(req);return json(res,200,await heartbeatAgent(m[1],i));}

    m=p.match(/^\/internal\/agents\/([^/]+)\/cancel$/);
    if(req.method==="POST"&&m){const i=await body(req);return json(res,200,await cancelAgent(m[1],i.reason));}

    m=p.match(/^\/internal\/agents\/([^/]+)\/complete$/);
    if(req.method==="POST"&&m){const i=await body(req);return json(res,200,await completeAgent(m[1],i.resultSummary));}

    m=p.match(/^\/internal\/agents\/([^/]+)\/workspace$/);
    if(req.method==="GET"&&m){const a=await getAgent(m[1]);if(!a)return json(res,404,{error:"Agent not found"});return json(res,200,a.workspace);}

    m=p.match(/^\/internal\/agents\/([^/]+)\/messages$/);
    if(req.method==="GET"&&m){const a=await getAgent(m[1]);if(!a)return json(res,404,{error:"Agent not found"});return json(res,200,a.messages);}

    return json(res,404,{error:"Not found"});
  } catch(e) {
    return json(res,400,{error:e.message||"Unexpected error"});
  }
});

server.listen(PORT,()=>console.log("RazeKit DEV listening on http://localhost:"+PORT));
