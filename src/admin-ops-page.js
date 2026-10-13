// The Admin Control Center at /admin/24-7.
//
// A static shell: every value on it comes from /api/admin/ops/*, which checks
// the caller on the server. Nothing here decides a status. A process is shown
// as running only when the API derived that from a fresh heartbeat; a control
// shows "completed" only when the target process completed it.

export const adminOpsPage = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#07111f">
<title>RazeKit DEV — Admin Control Center</title>
<style>
:root{--bg:#07111f;--panel:#0d1a2b;--panel-2:#101f33;--line:rgba(181,214,255,.12);--line-strong:rgba(181,214,255,.2);--text:#eef6ff;--muted:#8fa5bf;--accent:#50c7ff;--accent-2:#79e0ff;--success:#65e6a5;--warning:#ffd36a;--danger:#ff7f9c;--violet:#a58bff;--shadow:0 20px 60px rgba(0,0,0,.28);--radius:18px;--radius-sm:12px}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:radial-gradient(circle at 20% -10%,rgba(80,199,255,.11),transparent 32%),radial-gradient(circle at 95% 0%,rgba(122,100,255,.09),transparent 30%),var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}a{color:var(--accent)}
.wrap{max-width:1480px;margin:0 auto;padding:22px 20px 80px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.brand{display:flex;align-items:center;gap:12px}.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(145deg,#72dcff,#3561ff);display:grid;place-items:center;color:#03111e;font-weight:900}
.brand h1{margin:0;font-size:20px;letter-spacing:.01em}.brand p{margin:0;color:var(--muted);font-size:12px}
.top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{border:1px solid var(--line-strong);background:rgba(255,255,255,.04);color:var(--text);padding:8px 13px;border-radius:10px;font-weight:600;font-size:13px;white-space:nowrap}
.btn:hover:not(:disabled){border-color:var(--accent)}.btn.primary{background:linear-gradient(135deg,#50c7ff,#3a7bff);border-color:transparent;color:#03111e}
.btn.warn{border-color:rgba(255,211,106,.5);color:var(--warning)}.btn.danger{border-color:rgba(255,127,156,.55);color:var(--danger)}.btn.solid-danger{background:#c23a5a;border-color:#ff7f9c;color:#fff}
.btn.sm{padding:5px 9px;font-size:12px}
.banner{border:1px solid var(--line-strong);border-radius:12px;padding:10px 14px;margin:0 0 14px;display:none}
.banner.show{display:block}.banner.error{border-color:rgba(255,127,156,.5);background:rgba(255,127,156,.08);color:#ffd0db}.banner.warn{border-color:rgba(255,211,106,.45);background:rgba(255,211,106,.07);color:#ffe7a8}.banner.critical{border-color:#ff7f9c;background:rgba(194,58,90,.25);color:#fff;font-weight:600}
.meta-line{color:var(--muted);font-size:12px}
.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:26px 0 10px}
.section-title h2{margin:0;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-2)}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.panel{background:linear-gradient(180deg,rgba(16,31,51,.92),rgba(13,26,43,.92));border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;min-width:0}
.panel h3{margin:0;font-size:16px}.panel .sub{color:var(--muted);font-size:12px;margin:2px 0 0}
.phead{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:12px}
.code{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:8px;background:rgba(80,199,255,.14);color:var(--accent-2);font-weight:800;margin-right:8px;font-size:13px}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--line-strong);white-space:nowrap}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.s-running,.s-completed,.s-available,.s-pass{color:var(--success);border-color:rgba(101,230,165,.4)}
.s-starting,.s-accepted,.s-requested,.s-queued,.s-dispatched,.s-leased{color:var(--accent);border-color:rgba(80,199,255,.4)}
.s-paused,.s-stopping,.s-stale,.s-waiting_inference,.s-waiting_approval,.s-warn{color:var(--warning);border-color:rgba(255,211,106,.4)}
.s-failed,.s-offline,.s-dead_letter,.s-expired,.s-error,.s-critical,.s-fail,.s-unavailable{color:var(--danger);border-color:rgba(255,127,156,.45)}
.s-not_configured,.s-cancelled,.s-unknown,.s-info,.s-debug{color:var(--muted)}
.kv{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:4px 12px;font-size:13px;margin:0}
.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px;margin:12px 0}
.stat{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:12px;padding:8px 10px}.stat b{display:block;font-size:18px}.stat span{color:var(--muted);font-size:11px}
.progress{height:6px;background:rgba(255,255,255,.07);border-radius:99px;overflow:hidden;margin-top:6px}.progress i{display:block;height:100%;background:linear-gradient(90deg,#50c7ff,#65e6a5)}
.box{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:10px;background:rgba(3,10,20,.25)}
.box h4{margin:0 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.controls{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.list{list-style:none;margin:0;padding:0;display:grid;gap:6px}.list li{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;align-items:center;min-width:0}
.list li .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{color:var(--muted);font-size:12.5px;font-style:italic}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.table-wrap{overflow-x:auto}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;border:1px solid var(--line-strong);margin:1px 3px 1px 0}
.pill.yes{color:var(--success);border-color:rgba(101,230,165,.4)}.pill.no{color:var(--muted)}.pill.bad{color:var(--danger);border-color:rgba(255,127,156,.45)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
select,input[type=text],textarea{background:#091526;border:1px solid var(--line-strong);color:var(--text);border-radius:9px;padding:7px 9px;max-width:100%}
textarea{width:100%;min-height:64px;resize:vertical}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.form-grid .full{grid-column:1/-1}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.muted{color:var(--muted)}.small{font-size:12px}
.modal-back{position:fixed;inset:0;background:rgba(2,6,14,.7);display:none;align-items:center;justify-content:center;padding:16px;z-index:50}
.modal-back.show{display:flex}.modal{background:var(--panel-2);border:1px solid var(--line-strong);border-radius:16px;padding:18px;max-width:480px;width:100%}
.modal h3{margin:0 0 8px}.modal p{color:#cfe0f5;margin:0 0 12px}.modal .row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.toasts{position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:60;max-width:min(420px,calc(100vw - 32px))}
.toast{background:#0f2238;border:1px solid var(--line-strong);border-radius:12px;padding:10px 12px;font-size:13px;box-shadow:var(--shadow)}.toast.error{border-color:rgba(255,127,156,.6)}.toast.ok{border-color:rgba(101,230,165,.5)}
.req{font-size:12px;margin-top:8px;display:grid;gap:4px}
.skeleton{color:var(--muted);padding:30px;text-align:center}
@media (max-width:1100px){.grid3{grid-template-columns:1fr 1fr}}
@media (max-width:860px){.section-title{flex-direction:column;align-items:flex-start;gap:2px}.grid2,.grid3{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.wrap{padding:16px 16px 60px}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand"><div class="logo">R</div><div><h1>Admin Control Center</h1><p>24/7 systems · product agents · local models · compute</p></div></div>
    <div class="top-actions">
      <span class="meta-line" id="updatedAt">Loading…</span>
      <a class="btn" href="/">← Control Center</a>
      <button class="btn" id="refreshBtn">Refresh</button>
      <button class="btn solid-danger" id="emergencyBtn">Emergency stop</button>
    </div>
  </header>
  <div class="banner critical" id="emergencyBanner"></div>
  <div class="banner error" id="errorBanner"></div>
  <div class="banner warn" id="staleBanner"></div>

  <div id="content"><div class="panel skeleton">Loading live state from the server…</div></div>
</div>

<div class="modal-back" id="modalBack" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <div class="modal">
    <h3 id="modalTitle">Confirm</h3>
    <p id="modalText"></p>
    <div id="modalExtra"></div>
    <div class="row"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalOk">Confirm</button></div>
  </div>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>

<script>
(function () {
  var state = { data: null, lastOkAt: 0, logs: [], logFilter: { source: "", severity: "", taskId: "" }, audit: [], tracked: {}, timer: null, inflight: false };
  var $ = function (id) { return document.getElementById(id); };
  var REFRESH_MS = 5000;

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]; }); }
  function when(v) { if (!v) return "—"; var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function ago(ms) { if (ms == null) return "never"; var s = Math.round(ms / 1000); if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; }
  function agoFrom(iso) { return iso ? ago(Date.now() - Date.parse(iso)) : "never"; }
  function label(s) { return String(s || "unknown").replace(/_/g, " "); }
  function badge(s, text) { return '<span class="badge s-' + esc(s || "unknown") + '">' + esc(text || label(s)) + "</span>"; }
  function bytes(n) { if (n == null || isNaN(n)) return "—"; var u = ["B", "KB", "MB", "GB", "TB"], i = 0; n = Number(n); while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; }
  function num(n) { return n == null ? "—" : Number(n).toLocaleString(); }
  function money(n) { return n == null || isNaN(n) ? null : "$" + Number(n).toFixed(2); }

  function toast(msg, kind) { var n = document.createElement("div"); n.className = "toast " + (kind || ""); n.textContent = msg; $("toasts").appendChild(n); setTimeout(function () { n.remove(); }, 5200); }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, { method: opts.method || "GET", headers: { "Content-Type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "same-origin" });
    var data = {}; try { data = await res.json(); } catch (e) {}
    if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("Sign in required"); }
    if (!res.ok) { var err = new Error(data.error || ("Request failed (" + res.status + ")")); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  function confirmDialog(title, text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      $("modalTitle").textContent = title; $("modalText").textContent = text;
      $("modalExtra").innerHTML = opts.typeToConfirm ? '<input type="text" id="modalInput" style="width:100%" placeholder="Type ' + esc(opts.typeToConfirm) + ' to confirm" autocomplete="off">' : "";
      $("modalOk").textContent = opts.okText || "Confirm"; $("modalOk").className = "btn " + (opts.danger ? "solid-danger" : "primary");
      $("modalBack").classList.add("show");
      var input = $("modalInput"); if (input) input.focus(); else $("modalOk").focus();
      function done(v) { $("modalBack").classList.remove("show"); $("modalOk").onclick = null; $("modalCancel").onclick = null; resolve(v); }
      $("modalOk").onclick = function () { if (opts.typeToConfirm) { var v = ($("modalInput").value || "").trim(); if (v !== opts.typeToConfirm) { toast("Confirmation text does not match", "error"); return; } done(v); } else done(true); };
      $("modalCancel").onclick = function () { done(false); };
    });
  }

  // A control request is tracked until the target process resolves it.
  function trackRequest(key, request, path) {
    state.tracked[key] = { request: request, path: path || "/api/admin/ops/control-requests/" + request.id, since: Date.now() };
    pollTracked(key);
  }
  async function pollTracked(key) {
    var t = state.tracked[key]; if (!t) return;
    try {
      var data = await api(t.path); var r = data.request; t.request = r; renderTracked();
      if (["completed", "failed", "expired", "cancelled"].indexOf(r.status) >= 0) {
        if (r.status === "completed") toast(label(r.action || r.purpose || "request") + " completed — confirmed by " + (r.acceptedBy || r.gatewayId || "the process"), "ok");
        else toast(label(r.action || r.purpose || "request") + " " + r.status + (r.error ? ": " + r.error : ""), "error");
        setTimeout(function () { delete state.tracked[key]; renderTracked(); }, 15000);
        refresh();
        return;
      }
    } catch (e) { t.error = e.message; }
    if (Date.now() - t.since < 15 * 60 * 1000) setTimeout(function () { pollTracked(key); }, 2000);
  }
  function renderTracked() {
    Object.keys(state.tracked).forEach(function (key) {
      var el = document.querySelector('[data-track="' + key + '"]'); if (!el) return;
      var t = state.tracked[key], r = t.request || {};
      var steps = ["requested", "accepted", "completed"];
      var html = '<div class="req">' + steps.map(function (s) {
        var reached = s === "requested" || (s === "accepted" && ["accepted", "completed"].indexOf(r.status) >= 0) || (s === "completed" && r.status === "completed") || (s === "requested" && r.status);
        return '<span>' + badge(reached ? s : "not_configured", s) + (s === "accepted" && r.acceptedAt ? ' <span class="muted">' + esc(when(r.acceptedAt)) + " by " + esc(r.acceptedBy || "") + "</span>" : "") + "</span>";
      }).join("");
      if (["failed", "expired"].indexOf(r.status) >= 0) html += "<span>" + badge(r.status) + ' <span class="muted">' + esc(r.error || "") + "</span></span>";
      if (r.status === "requested") html += '<span class="muted small">Waiting for the live process to accept. A stopped process never accepts.</span>';
      if (r.status === "queued" || r.status === "dispatched") html += '<span class="muted small">' + esc(label(r.status)) + " at the inference gateway.</span>";
      el.innerHTML = html + "</div>";
    });
  }

  async function sendControl(path, body, key, confirmText, danger) {
    if (confirmText) { var ok = await confirmDialog("Confirm", confirmText, { danger: danger }); if (!ok) return; body.confirm = true; }
    try {
      var data = await api(path, { method: "POST", body: body });
      toast("Requested. Waiting for the process to confirm…");
      if (data.request) trackRequest(key, data.request);
      refresh();
    } catch (e) {
      if (e.data && e.data.needsConfirmation && !body.confirm) { body.confirm = true; return sendControl(path, body, key, e.message, true); }
      toast(e.message, "error");
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  function processBlock(p) {
    var hb = p.heartbeat || {};
    return '<dl class="kv">' +
      "<dt>Process</dt><dd>" + badge(p.status) + (p.reason ? ' <span class="muted small">' + esc(p.reason) + "</span>" : "") + "</dd>" +
      "<dt>Last heartbeat</dt><dd>" + (hb.at ? esc(when(hb.at)) + ' <span class="muted">(' + esc(ago(p.ageMs)) + ")</span>" : '<span class="muted">none received</span>') + "</dd>" +
      (hb.host ? "<dt>Host / PID</dt><dd class=\"mono\">" + esc(hb.host) + " / " + esc(hb.pid) + "</dd>" : "") +
      (hb.processStartedAt ? "<dt>Process started</dt><dd>" + esc(when(hb.processStartedAt)) + "</dd>" : "") +
      "</dl>";
  }

  function taskLine(t) {
    if (!t) return '<span class="empty">None</span>';
    return '<li><span class="t" title="' + esc(t.title) + '">' + esc(t.title) + ' <span class="muted mono">' + esc(t.kind) + (t.scopeArea ? " · " + esc(t.scopeArea) : "") + "</span></span>" + badge(t.status) + "</li>";
  }

  function systemPanel(s) {
    var p = s.process, live = ["running", "paused", "stopping", "starting"].indexOf(p.status) >= 0;
    var ct = s.currentTask;
    var current = ct ? '<div><b>' + esc(ct.title) + '</b> <span class="muted mono small">' + esc(ct.id) + "</span><div class=\"small muted\">" + esc(ct.progress && ct.progress.step || "") + " · attempt " + esc(ct.attempts) + "/" + esc(ct.maxAttempts) + '</div><div class="progress"><i style="width:' + Math.max(2, Number(ct.progress && ct.progress.pct || 0)) + '%"></i></div></div>'
      : '<span class="empty">' + (live ? "Idle — no task running" : "No live process") + "</span>";
    var q = s.queue;
    var html = '<section class="panel" id="sys-' + s.id + '">' +
      '<div class="phead"><div><h3><span class="code">' + esc(s.code) + "</span>SYSTEM " + esc(s.code) + " — " + esc(s.name) + '</h3><p class="sub">' + esc(s.purpose) + "</p></div>" + badge(p.status) + "</div>" +
      processBlock(p) +
      '<dl class="kv" style="margin-top:4px"><dt>Applied mode</dt><dd>' + esc(s.persistedMode) + (s.modeChangedAt ? ' <span class="muted small">since ' + esc(when(s.modeChangedAt)) + " by " + esc(s.modeChangedBy || "") + "</span>" : "") + "</dd></dl>" +
      '<div class="box"><h4>Current task</h4>' + current + "</div>" +
      '<div class="stats">' +
        '<div class="stat"><b>' + q.queued + '</b><span>Queued</span></div><div class="stat"><b>' + q.running + '</b><span>Running</span></div>' +
        '<div class="stat"><b>' + q.waitingInference + '</b><span>Waiting for AI</span></div><div class="stat"><b>' + (q.deadLetter + q.failed) + '</b><span>Failed</span></div></div>' +
      '<div class="box"><h4>Waiting in queue</h4><ul class="list">' + (s.queuedTasks.length ? s.queuedTasks.map(taskLine).join("") : '<li class="empty">Queue is empty</li>') + "</ul></div>" +
      '<div class="box"><h4>Last successful checkpoint</h4>' + (s.lastCheckpoint ? esc(s.lastCheckpoint.step) + ' <span class="muted small">#' + esc(s.lastCheckpoint.seq) + " · " + esc(when(s.lastCheckpoint.at)) + " · " + esc(s.lastCheckpoint.taskId) + "</span>" : '<span class="empty">No checkpoint yet</span>') + "</div>";
    if (s.id === "builder") {
      var tr = s.lastTestResult, pr = s.lastDraftPr, lc = s.lastCodeChange;
      html += '<div class="box"><h4>Last code change</h4>' + (lc ? esc(lc.summary) + ' <span class="muted small">' + esc(lc.branch || "") + " " + esc((lc.commit || "").slice(0, 7)) + " · " + esc(when(lc.at)) + "</span>" : '<span class="empty">None yet</span>') + "</div>" +
        '<div class="box"><h4>Last test result</h4>' + (tr ? badge(tr.passed ? "pass" : "fail", tr.passed ? "passed" : "failed") + " " + esc(tr.pass) + "/" + esc(tr.total) + " pass, " + esc(tr.fail) + " fail, " + esc(tr.skipped) + ' skipped <span class="muted small">· ' + esc(when(tr.at)) + "</span>" : '<span class="empty">No test run recorded</span>') + "</div>" +
        '<div class="box"><h4>Last GitHub draft PR</h4>' + (pr ? (/^https:\/\/github\.com\//.test(pr.url || "") ? '<a href="' + esc(pr.url) + '" target="_blank" rel="noopener noreferrer">#' + esc(pr.number) + "</a> " : "#" + esc(pr.number) + " ") + badge(pr.draft ? "paused" : "running", pr.draft ? "draft" : "open") + ' <span class="muted small">' + esc(when(pr.at)) + "</span>" : '<span class="empty">None opened yet</span>') + "</div>";
    } else {
      var h = s.runtimeHealth;
      html += '<div class="box"><h4>Live runtime health</h4>' + (h ? healthSummary(h) : '<span class="empty">No completed audit yet</span>') + "</div>" +
        '<div class="box"><h4>Audit findings (' + s.findings.length + ' open)</h4><ul class="list">' + (s.findings.length ? s.findings.slice(0, 8).map(function (f) { return '<li><span class="t" title="' + esc(f.detail) + '">' + esc(f.title) + (f.engineeringTaskId ? ' <span class="muted small">→ System A task</span>' : "") + "</span>" + badge(f.severity) + "</li>"; }).join("") : '<li class="empty">No open findings</li>') + "</ul></div>" +
        '<div class="box"><h4>Recovery operations</h4><ul class="list">' + (s.recoveryOperations.length ? s.recoveryOperations.slice(0, 5).map(function (r) { return "<li><span class=\"t\">" + esc(r.repairs.map(function (x) { return x.repair + " ×" + x.count; }).join(", ")) + '</span><span class="muted small">' + esc(when(r.at)) + "</span></li>"; }).join("") : '<li class="empty">None performed</li>') + "</ul></div>" +
        '<div class="box"><h4>Last successful audit</h4>' + (s.lastSuccessfulAudit ? esc(s.lastSuccessfulAudit.summary) + ' <span class="muted small">' + esc(when(s.lastSuccessfulAudit.at)) + "</span>" : '<span class="empty">None yet</span>') + "</div>" +
        '<div class="box"><h4>Recent failures</h4><ul class="list">' + (s.recentFailures.length ? s.recentFailures.map(function (t) { return '<li><span class="t" title="' + esc(t.error) + '">' + esc(t.title) + ": " + esc(t.error || "") + "</span>" + badge(t.status) + "</li>"; }).join("") : '<li class="empty">None</li>') + "</ul></div>" +
        '<div class="box"><h4>Monitored components</h4><div>' + s.monitoredComponents.map(function (c) { return '<span class="pill">' + esc(c) + "</span>"; }).join("") + "</div></div>";
    }
    if (s.recentErrors.length) html += '<div class="box"><h4>Recent errors</h4><ul class="list">' + s.recentErrors.slice(0, 4).map(function (e) { return '<li><span class="t" title="' + esc(e.message) + '">' + esc(e.message) + '</span><span class="muted small">' + esc(when(e.at)) + "</span></li>"; }).join("") + "</ul></div>";
    var paused = s.persistedMode === "paused";
    html += '<div class="controls">' +
      '<button class="btn primary sm" data-ctl="start" data-sys="' + s.id + '"' + (live && !paused ? " disabled" : "") + ">Start</button>" +
      '<button class="btn warn sm" data-ctl="pause" data-sys="' + s.id + '"' + (paused ? " disabled" : "") + ">Pause</button>" +
      '<button class="btn sm" data-ctl="resume" data-sys="' + s.id + '"' + (!paused ? " disabled" : "") + ">Resume</button>" +
      '<button class="btn danger sm" data-ctl="stop_task" data-sys="' + s.id + '" data-task="' + esc(ct ? ct.id : "") + '"' + (ct ? "" : " disabled") + ">Stop current task</button>" +
      "</div>" +
      (!live ? '<p class="small muted" style="margin:8px 0 0">The ' + esc(s.name) + " process is " + esc(label(p.status)) + ". Controls are recorded but take effect only when the process is running and accepts them. " + (p.status === "not_configured" ? "Deploy the process (see infra/aws/control-plane) to bring it online." : "") + "</p>" : "") +
      '<div data-track="sys-' + s.id + '"></div>' +
      '<div class="box"><h4>Recent control requests</h4><ul class="list">' + (s.controls.length ? s.controls.slice(0, 5).map(function (c) { return '<li><span class="t">' + esc(label(c.action)) + ' <span class="muted small">by ' + esc(c.requestedBy) + " · " + esc(when(c.requestedAt)) + (c.error ? " · " + esc(c.error) : "") + "</span></span>" + badge(c.status) + "</li>"; }).join("") : '<li class="empty">None</li>') + "</ul></div>" +
      taskForm(s) + "</section>";
    return html;
  }

  function healthSummary(h) {
    var rows = [];
    if (h.devRuntime) rows.push(["DEV runtime", h.devRuntime.configured ? badge(h.devRuntime.ok ? "running" : "failed", h.devRuntime.ok ? "healthy" : "unhealthy") + " " + esc(h.devRuntime.latencyMs) + "ms" + (h.devRuntime.store ? " · store " + esc(h.devRuntime.store) : "") : badge("not_configured")]);
    if (h.builder) rows.push(["System A", badge(h.builder.status)]);
    if (h.gateway) rows.push(["Gateway", badge(h.gateway.status) + (h.gateway.ollamaReachable === false ? ' <span class="muted small">model server unreachable</span>' : "")]);
    if (h.engineJobs) rows.push(["Engine jobs", esc(Object.keys(h.engineJobs.byStatus).map(function (k) { return k + " " + h.engineJobs.byStatus[k]; }).join(", ") || "none") + (h.engineJobs.expiredLeases ? " · " + esc(h.engineJobs.expiredLeases) + " expired leases" : "")]);
    if (h.workers) rows.push(["Worker leases", esc(h.workers.production) + " workers, " + esc(h.workers.staleProduction) + " stale"]);
    if (h.inferenceQueue) rows.push(["Inference queue", esc(h.inferenceQueue.queued) + " queued, " + esc(h.inferenceQueue.dispatched) + " running"]);
    if (h.host) rows.push(["Control-plane host", "load " + esc((h.host.loadavg || [])[0] != null ? h.host.loadavg[0].toFixed(2) : "—") + " · mem free " + esc(bytes(h.host.freeMemBytes)) + " · disk free " + esc(bytes(h.host.diskFreeBytes))]);
    return '<dl class="kv">' + rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + r[1] + "</dd>"; }).join("") + "</dl>";
  }

  function taskForm(s) {
    if (s.id === "builder") {
      return '<details class="box"><summary class="small" style="cursor:pointer">Queue a System A task</summary><form data-taskform="builder" class="form-grid" style="margin-top:8px">' +
        '<select name="kind"><option value="code.change">Implement a change (draft PR)</option><option value="repo.inspect">Inspect repository &amp; run tests</option></select>' +
        '<select name="scopeArea">' + s.scopeAreas.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.label) + "</option>"; }).join("") + "</select>" +
        '<input class="full" type="text" name="title" placeholder="Title" required maxlength="200">' +
        '<textarea class="full" name="goal" placeholder="Goal and acceptance criteria"></textarea>' +
        '<div class="full"><button class="btn primary sm" type="submit">Queue task</button> <span class="small muted">Runs only when the System A process claims it. Never merged or deployed.</span></div></form></details>';
    }
    return '<div class="controls" style="border-top:0;padding-top:0"><button class="btn sm" data-audit-now="1">Queue an audit now</button></div>';
  }

  function agentPanel(a) {
    var av = a.availability;
    var paused = a.control && a.control.mode === "paused";
    return '<section class="panel"><div class="phead"><div><h3>' + esc(a.name) + '</h3><p class="sub">' + esc(a.role) + "</p></div>" + badge(av.state) + "</div>" +
      '<p class="small muted" style="margin:0 0 8px">' + esc(av.reason) + "</p>" +
      '<dl class="kv"><dt>Control mode</dt><dd>' + esc(a.control.mode) + (a.control.appliedAt ? ' <span class="muted small">applied ' + esc(when(a.control.appliedAt)) + " by " + esc(a.control.appliedBy || "") + "</span>" : "") + "</dd>" +
      "<dt>Current workflow</dt><dd>" + (a.currentWorkflow.length ? a.currentWorkflow.map(function (w) { return esc(w.taskTitle || w.taskId) + ' <span class="muted small">' + esc(w.executionState || "") + (w.runningNodes.length ? " · " + esc(w.runningNodes.join(", ")) : "") + "</span>"; }).join("<br>") : '<span class="empty">No running instance</span>') + "</dd>" +
      "<dt>Assigned tasks</dt><dd>" + (a.assignedTasks.length ? a.assignedTasks.map(function (t) { return esc(t.title) + " " + badge(t.status); }).join("<br>") : '<span class="empty">None</span>') + "</dd>" +
      "<dt>Last successful run</dt><dd>" + (a.lastSuccessfulRun ? esc(a.lastSuccessfulRun.kind) + " · " + esc(when(a.lastSuccessfulRun.completedAt)) + ' <span class="muted mono small">' + esc(a.lastSuccessfulRun.taskId) + "</span>" : '<span class="empty">None recorded</span>') + "</dd></dl>" +
      '<div class="box"><h4>Errors</h4><ul class="list">' + (a.errors.length ? a.errors.slice(0, 4).map(function (e) { return '<li><span class="t" title="' + esc(e.message) + '">' + esc(e.message) + '</span><span class="muted small">' + esc(when(e.at)) + "</span></li>"; }).join("") : '<li class="empty">None</li>') + "</ul></div>" +
      '<div class="box"><h4>Execution history</h4><ul class="list">' + (a.history.length ? a.history.slice(0, 6).map(function (t) { return '<li><span class="t">' + esc(t.title) + "</span>" + badge(t.status) + "</li>"; }).join("") : '<li class="empty">No tasks yet</li>') + "</ul></div>" +
      '<div class="controls"><button class="btn warn sm" data-agent="' + a.id + '" data-agent-action="pause"' + (paused ? " disabled" : "") + '>Pause ' + esc(a.name) + '</button><button class="btn sm" data-agent="' + a.id + '" data-agent-action="resume"' + (!paused ? " disabled" : "") + '>Resume ' + esc(a.name) + "</button></div>" +
      '<p class="small muted" style="margin:6px 0 0">Applied by the runtime coordinator that advances ' + esc(a.name) + "; shown completed only after it applies.</p>" +
      '<div data-track="agent-' + a.id + '"></div></section>';
  }

  function modelsSection(m) {
    var st = m.status || {}, models = st.models || {};
    var rows = ["coding", "reasoning"].map(function (slot) {
      var cfg = m.config.slots[slot], info = models[cfg.model] || {}, test = info.lastTest;
      var installed = info.installed === true, loaded = info.loaded === true, tested = info.lastSuccessfulTestAt;
      return "<tr><td><b>" + esc(slot === "coding" ? "Coding" : "Reasoning / review") + '</b><div class="muted small">' + esc(cfg.role) + "</div></td>" +
        '<td class="mono">' + esc(cfg.model) + '<div class="muted small">ctx ' + esc(cfg.contextTokens) + "</div></td>" +
        "<td>" + '<span class="pill ' + (st.reachable ? (installed ? "yes" : "no") : "no") + '">' + (st.reachable ? (installed ? "installed " + esc(bytes(info.sizeBytes)) : "not installed") : "install status unknown") + "</span>" +
        '<span class="pill ' + (loaded ? "yes" : "no") + '">' + (loaded ? "loaded · " + esc(bytes(info.vramBytes)) + " VRAM" : "not loaded") + "</span>" +
        '<span class="pill ' + (tested ? "yes" : (test && !test.ok ? "bad" : "no")) + '">' + (tested ? "inference test passed " + esc(agoFrom(tested)) : (test ? "last test failed" : "never tested")) + "</span>" +
        (test ? '<div class="muted small">' + esc(test.kind || "smoke") + " · " + esc(when(test.at)) + (test.error ? " · " + esc(test.error) : "") + "</div>" : "") + "</td>" +
        '<td><button class="btn sm" data-model-test="' + slot + '">Test inference</button> <button class="btn sm" data-model-accept="' + slot + '">' + (slot === "coding" ? "Coding" : "Reasoning") + ' acceptance test</button>' +
        ' <select data-model-select="' + slot + '">' + m.supported.map(function (id) { return '<option value="' + esc(id) + '"' + (id === cfg.model ? " selected" : "") + ">" + esc(id) + "</option>"; }).join("") + '</select> <button class="btn sm warn" data-model-assign="' + slot + '">Change</button>' +
        '<div data-track="model-' + slot + '"></div></td></tr>';
    }).join("");
    var g = m.gateway;
    var usage = function (list, field) { return list.length ? "<table><thead><tr><th>" + esc(field) + "</th><th>Requests</th><th>Prompt tok</th><th>Output tok</th><th>GPU time</th></tr></thead><tbody>" + list.map(function (u) { return "<tr><td>" + esc(u[field]) + "</td><td>" + num(u.requests) + "</td><td>" + num(u.promptTokens) + "</td><td>" + num(u.completionTokens) + "</td><td>" + esc(Math.round(u.totalDurationMs / 1000)) + "s</td></tr>"; }).join("") + "</tbody></table>" : '<span class="empty">No measured usage yet</span>'; };
    return '<section class="panel"><div class="phead"><div><h3>Local AI model gateway</h3><p class="sub">Two independent slots on one queue; only one model is loaded on the GPU at a time.</p></div>' + badge(g.status, "gateway " + label(g.status)) + "</div>" +
      processBlock(g) +
      '<dl class="kv" style="margin-top:4px"><dt>Model server</dt><dd>' + (st.checkedAt ? (st.reachable ? badge("running", "reachable") + " " + esc(st.runtime ? st.runtime.name + " " + st.runtime.version : "") : badge("offline", "unreachable") + ' <span class="muted small">' + esc(st.error || "") + "</span>") + ' <span class="muted small">checked ' + esc(agoFrom(st.checkedAt)) + "</span>" : badge("not_configured", "never checked")) + "</dd>" +
      "<dt>Loaded now</dt><dd>" + (st.loaded && st.loaded.length ? st.loaded.map(function (l) { return esc(l.name) + " (" + esc(bytes(l.vramBytes)) + " VRAM)"; }).join(", ") : '<span class="muted">nothing loaded</span>') + "</dd>" +
      "<dt>Inference queue</dt><dd>" + esc(m.queue.queued) + " queued, " + esc(m.queue.dispatched) + " running" + (m.queue.oldestQueuedAt ? ' <span class="muted small">oldest ' + esc(agoFrom(m.queue.oldestQueuedAt)) + "</span>" : "") + "</dd>" +
      "<dt>Last successful inference</dt><dd>" + (m.lastSuccessfulInference ? esc(m.lastSuccessfulInference.model) + " for " + esc(m.lastSuccessfulInference.requester) + " · " + esc(when(m.lastSuccessfulInference.completedAt)) : '<span class="empty">None yet</span>') + "</dd>" +
      "<dt>Niomi/Konami loop</dt><dd class=\"small\">" + esc(m.agentLoopModels ? (m.agentLoopModels.mode + " · coding " + (m.agentLoopModels.fable ? m.agentLoopModels.fable.provider + ":" + m.agentLoopModels.fable.model : "—") + " · planning " + (m.agentLoopModels.astra ? m.agentLoopModels.astra.provider + ":" + m.agentLoopModels.astra.model : "—")) : "unknown") + "</dd></dl>" +
      '<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Slot</th><th>Assigned model</th><th>Installed · loaded · tested</th><th>Actions</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<div class="grid3" style="margin-top:12px"><div class="box"><h4>Usage by system (30d)</h4>' + usage(m.usageByRequester, "requester") + '</div><div class="box"><h4>Usage by slot</h4>' + usage(m.usageBySlot, "slot") + '</div><div class="box"><h4>Usage by model</h4>' + usage(m.usageByModel, "model") + "</div></div>" +
      '<div class="box"><h4>Recent inference requests</h4><div class="table-wrap"><table><thead><tr><th>When</th><th>Requester</th><th>Slot</th><th>Model</th><th>Status</th><th>Tokens</th><th>Error</th></tr></thead><tbody>' +
      (m.recentRequests.length ? m.recentRequests.map(function (r) { return "<tr><td>" + esc(when(r.createdAt)) + "</td><td>" + esc(r.requester) + "</td><td>" + esc(r.slot) + '</td><td class="mono">' + esc(r.model || "—") + "</td><td>" + badge(r.status) + "</td><td>" + (r.usage ? num(r.usage.promptTokens + r.usage.completionTokens) : "—") + '</td><td class="small">' + esc(r.error || "") + "</td></tr>"; }).join("") : '<tr><td colspan="7" class="empty">No inference requests yet</td></tr>') +
      "</tbody></table></div></div></section>";
  }

  function computeSection(c) {
    var gpu = c.gpu || {}, cost = c.gpuCost, b = c.awsBudget;
    var procRows = c.processes.map(function (p) { var hb = p.heartbeat || {}, r = hb.resources || {}; return "<tr><td>" + esc(p.source) + "</td><td>" + badge(p.status) + "</td><td class=\"mono\">" + esc(hb.host || "—") + "</td><td>" + (r.loadavg ? esc(r.loadavg[0].toFixed(2)) : "—") + "</td><td>" + esc(bytes(r.freeMemBytes)) + " / " + esc(bytes(r.totalMemBytes)) + "</td><td>" + esc(bytes(r.rssBytes)) + "</td><td>" + esc(hb.at ? ago(p.ageMs) : "never") + "</td></tr>"; }).join("");
    return '<section class="panel"><div class="phead"><div><h3>AWS compute and spending</h3><p class="sub">Figures are shown only when a real source reported them; otherwise “Not configured” or “Unavailable”.</p></div></div>' +
      '<div class="box"><h4>CPU control-plane processes</h4><div class="table-wrap"><table><thead><tr><th>Process</th><th>Status</th><th>Host</th><th>Load</th><th>Free / total mem</th><th>RSS</th><th>Heartbeat</th></tr></thead><tbody>' + procRows + "</tbody></table></div></div>" +
      '<div class="grid2" style="margin-top:2px"><div class="box"><h4>GPU inference instance</h4><dl class="kv">' +
      "<dt>State</dt><dd>" + (gpu.configured ? badge(gpu.state === "running" ? "running" : (gpu.state === "stopped" ? "paused" : "starting"), gpu.state) + ' <span class="muted small">' + esc(gpu.source || "") + " · " + esc(agoFrom(gpu.observedAt || gpu.checkedAt)) + "</span>" : badge("not_configured", "Not configured")) + "</dd>" +
      (gpu.instanceId ? "<dt>Instance</dt><dd class=\"mono\">" + esc(gpu.instanceId) + " · " + esc(gpu.instanceType || "") + "</dd>" : "") +
      "<dt>Last activity</dt><dd>" + esc(gpu.lastActivityAt ? when(gpu.lastActivityAt) : "—") + "</dd>" +
      "<dt>Idle shutdown</dt><dd>after " + esc(c.idleStopMinutes) + " min without inference</dd>" +
      (gpu.lastError ? "<dt>Error</dt><dd class=\"small\">" + esc(gpu.lastError) + "</dd>" : "") +
      '</dl><div class="controls"><button class="btn primary sm" data-gpu="start"' + (c.gpuControlsAvailable && gpu.state === "stopped" ? "" : " disabled") + '>Start GPU</button><button class="btn danger sm" data-gpu="stop"' + (c.gpuControlsAvailable && gpu.state === "running" ? "" : " disabled") + ">Stop GPU</button></div>" +
      (c.gpuControlsReason ? '<p class="small muted" style="margin:6px 0 0">Controls unavailable: ' + esc(c.gpuControlsReason) + "</p>" : "") + '<div data-track="gpu"></div></div>' +
      '<div class="box"><h4>Spending</h4><dl class="kv">' +
      "<dt>GPU hours this month</dt><dd>" + (cost ? esc(cost.runningHours) + " h <span class=\"muted small\">(measured from observed instance state)</span>" : "Unavailable") + "</dd>" +
      "<dt>GPU estimated cost</dt><dd>" + (cost && cost.estimatedUsd != null ? esc(money(cost.estimatedUsd)) + ' <span class="muted small">' + esc(cost.rateSource) + "</span>" : "Not configured") + "</dd>" +
      "<dt>GPU budget / remaining</dt><dd>" + (cost && cost.budgetUsd != null ? esc(money(cost.budgetUsd)) + " / " + esc(money(cost.remainingUsd) || "—") + (cost.remainingUsd != null && cost.remainingUsd < cost.budgetUsd * 0.2 ? " " + badge("warn", "shutdown warning") : "") : "Not configured") + "</dd>" +
      "<dt>AWS budget (recorded)</dt><dd>" + (b && b.configured && !b.error ? esc(money(b.actualUsd)) + " of " + esc(money(b.limitUsd)) + (isNaN(b.forecastUsd) ? "" : ", forecast " + esc(money(b.forecastUsd))) + ' <span class="muted small">' + esc(b.source) + " · AWS updated " + esc(when(b.lastUpdatedAt)) + "</span>" : (b && b.error ? "Unavailable: " + esc(b.error) : "Not configured")) + "</dd>" +
      "<dt>Source</dt><dd class=\"small muted\">" + esc(c.awsBudgetSource || "No System B audit has read AWS yet") + "</dd>" +
      "<dt>Credits</dt><dd class=\"small muted\">Not read by the platform. Check AWS Billing → Credits.</dd></dl></div></div></section>";
  }

  function approvalsSection(list) {
    return '<section class="panel"><div class="phead"><div><h3>Approvals</h3><p class="sub">Sensitive operations waiting for your decision.</p></div>' + badge(list.length ? "waiting_approval" : "completed", list.length + " pending") + "</div><ul class=\"list\">" +
      (list.length ? list.map(function (a) { return '<li><span class="t" title="' + esc(JSON.stringify(a.details)) + '"><b>' + esc(a.kind) + "</b> · " + esc(a.summary) + ' <span class="muted small">' + esc(a.system) + " · " + esc(when(a.requestedAt)) + '</span></span><span><button class="btn sm primary" data-approve="' + esc(a.id) + '">Approve</button> <button class="btn sm danger" data-deny="' + esc(a.id) + '">Deny</button></span></li>'; }).join("") : '<li class="empty">Nothing waiting for approval</li>') + "</ul></section>";
  }

  function logsSection() {
    var f = state.logFilter;
    var opt = function (v, cur) { return '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + (v || "all") + "</option>"; };
    return '<section class="panel"><div class="phead"><div><h3>Activity logs</h3><p class="sub">Persisted events from System A, System B, the gateway, Niomi, Konami and admin actions. Secrets are redacted before storage.</p></div></div>' +
      '<form class="filters" id="logFilter"><select name="source">' + ["", "builder", "auditor", "gateway", "niomi", "konami", "admin"].map(function (v) { return opt(v, f.source); }).join("") + '</select><select name="severity">' + ["", "info", "warn", "error", "critical"].map(function (v) { return opt(v, f.severity); }).join("") + '</select><input type="text" name="taskId" placeholder="Task ID" value="' + esc(f.taskId) + '"><button class="btn sm" type="submit">Filter</button></form>' +
      '<div class="table-wrap" style="max-height:420px;overflow-y:auto"><table><thead><tr><th>Time</th><th>Source</th><th>Severity</th><th>Action</th><th>Task</th><th>Result</th><th>Message</th></tr></thead><tbody id="logRows">' + logRows() + "</tbody></table></div></section>";
  }
  function logRows() {
    if (!state.logs.length) return '<tr><td colspan="7" class="empty">No matching log entries</td></tr>';
    return state.logs.map(function (e) { return "<tr><td class=\"small\">" + esc(when(e.at)) + "</td><td>" + esc(e.source) + "</td><td>" + badge(e.severity) + '</td><td class="mono">' + esc(e.action) + '</td><td class="mono small">' + esc(e.taskId || "") + "</td><td>" + esc(e.result || "") + '</td><td class="small">' + esc(e.message) + "</td></tr>"; }).join("");
  }
  function auditSection() {
    return '<section class="panel"><div class="phead"><div><h3>Administrative audit trail</h3><p class="sub">Every control, assignment and approval, accepted or rejected.</p></div></div><div class="table-wrap" style="max-height:320px;overflow-y:auto"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead><tbody>' +
      (state.audit.length ? state.audit.map(function (a) { return "<tr><td class=\"small\">" + esc(when(a.at)) + "</td><td>" + esc(a.actor) + '</td><td class="mono">' + esc(a.action) + "</td><td>" + esc(a.target || "") + "</td><td>" + badge(a.outcome === "accepted" ? "completed" : "failed", a.outcome) + (a.details && a.details.error ? ' <span class="small muted">' + esc(a.details.error) + "</span>" : "") + "</td></tr>"; }).join("") : '<tr><td colspan="5" class="empty">No admin actions recorded yet</td></tr>') + "</tbody></table></div></section>";
  }

  function render() {
    var d = state.data; if (!d) return;
    var e = d.emergency || {};
    $("emergencyBanner").className = "banner critical" + (e.engaged ? " show" : "");
    $("emergencyBanner").innerHTML = e.engaged ? "EMERGENCY STOP ENGAGED by " + esc(e.by) + " at " + esc(when(e.at)) + " — " + esc(e.reason || "") + ' <button class="btn sm" id="releaseEmergency" style="margin-left:8px">Release</button>' : "";
    $("emergencyBtn").disabled = !!e.engaged;
    var openDetails = Array.prototype.map.call(document.querySelectorAll("details[open]"), function (n) { return n.querySelector("form") ? n.querySelector("form").getAttribute("data-taskform") : ""; });
    var drafts = {}; Array.prototype.forEach.call(document.querySelectorAll("[data-taskform] input,[data-taskform] textarea,[data-taskform] select"), function (n) { drafts[n.name] = n.value; });
    var html =
      '<div class="section-title"><h2>A · 24/7 supervisory systems</h2><span class="meta-line">Two independent processes, queues and controls · heartbeat stale after ' + Math.round(d.thresholds.staleAfterMs / 1000) + "s, offline after " + Math.round(d.thresholds.offlineAfterMs / 1000) + "s</span></div>" +
      '<div class="grid2">' + systemPanel(d.systems.builder) + systemPanel(d.systems.auditor) + "</div>" +
      '<div class="section-title"><h2>B · Product agents</h2><span class="meta-line">Governed by the 24/7 systems; not supervisors themselves</span></div>' +
      '<div class="grid2">' + agentPanel(d.agents.niomi) + agentPanel(d.agents.konami) + "</div>" +
      '<div class="section-title"><h2>C · Local AI models</h2></div>' + modelsSection(d.models) +
      '<div class="section-title"><h2>D · Compute and spending</h2></div>' + computeSection(d.compute) +
      '<div class="section-title"><h2>E · Logs, audit and approvals</h2></div>' + approvalsSection(d.approvals) + '<div style="height:14px"></div>' + logsSection() + '<div style="height:14px"></div>' + auditSection();
    $("content").innerHTML = html;
    openDetails.forEach(function (k) { var f = document.querySelector('[data-taskform="' + k + '"]'); if (f) f.parentElement.open = true; });
    Object.keys(drafts).forEach(function (k) { var n = document.querySelector('[data-taskform] [name="' + k + '"]'); if (n && drafts[k]) n.value = drafts[k]; });
    renderTracked();
  }

  function renderFreshness() {
    if (!state.lastOkAt) return;
    var age = Date.now() - state.lastOkAt;
    $("updatedAt").textContent = "Updated " + ago(age) + " · server time " + when(state.data && state.data.generatedAt);
    $("staleBanner").className = "banner warn" + (age > 20000 ? " show" : "");
    $("staleBanner").textContent = age > 20000 ? "Data may be stale: the last successful refresh was " + ago(age) + ". Values below are from " + when(state.data.generatedAt) + "." : "";
  }

  async function refresh() {
    if (state.inflight) return; state.inflight = true;
    try {
      var data = await api("/api/admin/ops/dashboard");
      state.data = data; state.lastOkAt = Date.now();
      $("errorBanner").className = "banner error";
      var f = state.logFilter, qs = "?limit=200" + (f.source ? "&source=" + encodeURIComponent(f.source) : "") + (f.severity ? "&severity=" + encodeURIComponent(f.severity) : "") + (f.taskId ? "&taskId=" + encodeURIComponent(f.taskId) : "");
      var logs = await api("/api/admin/ops/logs" + qs); state.logs = logs.events;
      var audit = await api("/api/admin/ops/audit"); state.audit = audit.entries;
      if (!document.querySelector(".modal-back.show") && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) render();
    } catch (e) {
      $("errorBanner").className = "banner error show";
      $("errorBanner").textContent = (e.status === 403 ? "Administrator access required. " : "Could not load live state: ") + e.message + (state.data ? " — showing the last data received." : "");
      if (!state.data) $("content").innerHTML = '<div class="panel skeleton">' + esc(e.status === 403 ? "This page is for owners and administrators." : "No data could be loaded from the server.") + "</div>";
    } finally { state.inflight = false; renderFreshness(); }
  }

  // ── Events ─────────────────────────────────────────────────────────────
  document.addEventListener("click", async function (ev) {
    var t = ev.target.closest("button"); if (!t || t.disabled) return;
    if (t.id === "refreshBtn") return refresh();
    if (t.id === "emergencyBtn") {
      var v = await confirmDialog("Engage emergency stop", "Every supervisor, the inference gateway and the Niomi/Konami coordinator will stop autonomous work on their next loop; running tasks are interrupted at a safe point and returned to the queue. This is persisted on the server.", { typeToConfirm: "STOP", okText: "Engage", danger: true });
      if (!v) return;
      try { await api("/api/admin/ops/emergency-stop", { method: "POST", body: { engaged: true, confirm: "STOP", reason: "Engaged from the admin control center" } }); toast("Emergency stop persisted on the server", "ok"); } catch (e) { toast(e.message, "error"); }
      return refresh();
    }
    if (t.id === "releaseEmergency") {
      if (!(await confirmDialog("Release emergency stop", "Autonomous work may resume. Systems you paused stay paused."))) return;
      try { await api("/api/admin/ops/emergency-stop", { method: "POST", body: { engaged: false } }); toast("Emergency stop released", "ok"); } catch (e) { toast(e.message, "error"); }
      return refresh();
    }
    if (t.dataset.ctl) {
      var sys = t.dataset.sys, action = t.dataset.ctl, body = { action: action };
      if (action === "stop_task") body.taskId = t.dataset.task;
      var text = action === "pause" ? "Pause " + (sys === "builder" ? "System A" : "System B") + "? The running task stops at its next safe point and returns to the queue." : action === "stop_task" ? "Stop task " + t.dataset.task + "? It will be cancelled by its process." : null;
      return sendControl("/api/admin/ops/systems/" + sys + "/control", body, "sys-" + sys, text, action === "stop_task");
    }
    if (t.dataset.agent) {
      var a = t.dataset.agent, act = t.dataset.agentAction;
      return sendControl("/api/admin/ops/agents/" + a + "/control", { action: act }, "agent-" + a, act === "pause" ? "Pause " + a + "? The coordinator will stop starting and advancing its tasks." : null);
    }
    if (t.dataset.modelTest) {
      try { var r = await api("/api/admin/ops/models/" + t.dataset.modelTest + "/test", { method: "POST", body: {} }); toast("Inference test queued"); trackRequest("model-" + t.dataset.modelTest, r.request, "/api/admin/ops/inference/" + r.request.id); } catch (e) { toast(e.message, "error"); }
      return;
    }
    if (t.dataset.modelAccept) {
      if (!(await confirmDialog("Queue acceptance test", "System A will run the " + t.dataset.modelAccept + " model acceptance test on real inference. It waits in the queue while the GPU is off."))) return;
      try { var at = await api("/api/admin/ops/models/" + t.dataset.modelAccept + "/acceptance-test", { method: "POST", body: {} }); toast("Queued as System A task " + at.task.id); refresh(); } catch (e) { toast(e.message, "error"); }
      return;
    }
    if (t.dataset.modelAssign) {
      var slot = t.dataset.modelAssign, sel = document.querySelector('[data-model-select="' + slot + '"]').value;
      var typed = await confirmDialog("Change " + slot + " model", "Assign " + sel + " to the " + slot + " slot. Future requests for this slot use it.", { typeToConfirm: sel, okText: "Change" });
      if (!typed) return;
      try { await api("/api/admin/ops/models/" + slot, { method: "PUT", body: { model: sel, confirm: typed } }); toast("Assignment saved on the server", "ok"); } catch (e) { toast(e.message, "error"); }
      return refresh();
    }
    if (t.dataset.gpu) {
      var ga = t.dataset.gpu, gb = { action: ga };
      if (!(await confirmDialog((ga === "start" ? "Start" : "Stop") + " GPU", ga === "start" ? "Start the GPU instance. It is billed while running and stops automatically when idle." : "Stop the GPU instance. Model weights stay on its encrypted volume."))) return;
      gb.confirm = true;
      try { var gr = await api("/api/admin/ops/compute/gpu", { method: "POST", body: gb }); trackRequest("gpu", gr.request); toast("GPU " + ga + " requested"); }
      catch (e) {
        if (e.data && e.data.activeJobs) { if (await confirmDialog("Active jobs", e.message, { danger: true })) { gb.confirmActiveJobs = true; try { var g2 = await api("/api/admin/ops/compute/gpu", { method: "POST", body: gb }); trackRequest("gpu", g2.request); } catch (e2) { toast(e2.message, "error"); } } }
        else toast(e.message, "error");
      }
      return refresh();
    }
    if (t.dataset.approve || t.dataset.deny) {
      var id = t.dataset.approve || t.dataset.deny, decision = t.dataset.approve ? "approved" : "denied";
      if (!(await confirmDialog((decision === "approved" ? "Approve" : "Deny") + " request", "Record your decision for " + id + "."))) return;
      try { await api("/api/admin/ops/approvals/" + id + "/decision", { method: "POST", body: { decision: decision } }); toast("Decision recorded", "ok"); } catch (e) { toast(e.message, "error"); }
      return refresh();
    }
    if (t.dataset.auditNow) {
      try { await api("/api/admin/ops/systems/auditor/tasks", { method: "POST", body: { kind: "audit.cycle", title: "Manual audit" } }); toast("Audit queued for System B"); } catch (e) { toast(e.message, "error"); }
      return refresh();
    }
  });

  document.addEventListener("submit", async function (ev) {
    var form = ev.target;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (form.id === "logFilter") { ev.preventDefault(); var fd = new FormData(form); state.logFilter = { source: fd.get("source") || "", severity: fd.get("severity") || "", taskId: (fd.get("taskId") || "").trim() }; return refresh(); }
    if (form.dataset.taskform) {
      ev.preventDefault();
      var f2 = new FormData(form), body = { kind: f2.get("kind"), title: f2.get("title"), goal: f2.get("goal"), scopeArea: f2.get("scopeArea") };
      try { var r = await api("/api/admin/ops/systems/" + form.dataset.taskform + "/tasks", { method: "POST", body: body }); toast("Queued " + r.task.id + " — runs when System A claims it"); form.reset(); refresh(); } catch (e) { toast(e.message, "error"); }
    }
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && $("modalBack").classList.contains("show")) $("modalCancel").click(); });

  function schedule() { clearTimeout(state.timer); state.timer = setTimeout(function () { if (!document.hidden) refresh().then(schedule); else schedule(); }, REFRESH_MS); }
  setInterval(renderFreshness, 1000);
  refresh().then(schedule);
})();
</script>
</body>
</html>`;
