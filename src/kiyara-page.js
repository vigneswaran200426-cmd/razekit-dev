// Kiyara's page: a text conversation with the RazeKit DEV assistant.
//
// Every value shown here comes from /api/kiyara/*. Text is inserted with
// textContent only, never as markup. Her state is the server's state; the page
// does not animate "working" on its own. The character artwork is a slot to be
// filled from the approved Kiyara model sheet; until then a plain monogram
// stands in, so no unapproved likeness is invented.

export const kiyaraPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#07111f">
<title>Kiyara — RazeKit DEV</title>
<style>
:root{--bg:#07111f;--panel:#0d1a2b;--panel2:#101f33;--line:rgba(181,214,255,.12);--text:#eef6ff;--muted:#8fa5bf;
--teal:#2fd3c4;--amber:#ffd36a;--red:#ff7f9c;--green:#65e6a5;--gray:#8fa5bf}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--teal)}
button,input{font:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:20px 16px 40px;display:grid;gap:16px;grid-template-columns:300px minmax(0,1fr)}
header{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
header h1{font-size:20px;margin:0}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px}
.avatar{width:120px;height:120px;border-radius:50%;margin:4px auto 12px;display:grid;place-items:center;font-size:44px;font-weight:800;
background:radial-gradient(circle at 35% 30%,#1c3a52,#0b1726);border:4px solid var(--gray);transition:border-color .3s}
.avatar[data-state=working]{border-color:var(--teal)}
.avatar[data-state=approval_needed]{border-color:var(--amber)}
.avatar[data-state=completed]{border-color:var(--green)}
.avatar[data-state=blocked]{border-color:var(--red)}
@media (prefers-reduced-motion:no-preference){.avatar[data-state=working]{animation:pulse 2.4s ease-in-out infinite}}
@keyframes pulse{50%{box-shadow:0 0 0 10px rgba(47,211,196,.08)}}
.name{text-align:center;font-weight:700;font-size:18px}
.state{text-align:center;margin:4px 0 12px;font-weight:600}
.state[data-state=working]{color:var(--teal)}.state[data-state=approval_needed]{color:var(--amber)}
.state[data-state=completed]{color:var(--green)}.state[data-state=blocked]{color:var(--red)}.state[data-state=idle]{color:var(--gray)}
.facts{display:grid;gap:6px;font-size:13px;color:var(--muted)}
.facts b{color:var(--text);font-weight:600}
.note{font-size:12px;color:var(--muted);margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.chat{display:flex;flex-direction:column;min-height:520px}
.log{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px 2px 12px;max-height:60vh}
.msg{max-width:85%;padding:10px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}
.msg.user{align-self:flex-end;background:#163049}
.msg.kiyara{align-self:flex-start;background:var(--panel2);border:1px solid var(--line)}
.msg.error{border-color:rgba(255,127,156,.5)}
.evidence{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.evidence a{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;text-decoration:none}
.confirm{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:#12263b;color:var(--text);border-radius:10px;padding:8px 14px;cursor:pointer}
.btn.primary{background:var(--teal);color:#03211e;border-color:transparent;font-weight:700}
.btn:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
form{display:flex;gap:8px}
form input{flex:1;min-width:0;background:#0a1626;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:10px 12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:760px){.wrap{grid-template-columns:1fr}.avatar{width:88px;height:88px;font-size:32px}.chat{min-height:420px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Talk to Kiyara</h1>
    <nav><a href="/">← Control Center</a></nav>
  </header>
  <aside class="panel" aria-labelledby="kname">
    <div class="avatar" id="avatar" data-state="idle" aria-hidden="true">K</div>
    <div class="name" id="kname">Kiyara <span style="color:var(--muted);font-weight:400">(Kiya)</span></div>
    <div class="state" id="state" data-state="idle" aria-live="polite">Loading…</div>
    <div class="facts" id="facts"></div>
    <p class="note">Kiyara is an AI assistant. She reports only what the platform's records show and acts only through your account's permissions. Text only: no speech pipeline is configured. Character artwork will come from the approved model sheet.</p>
  </aside>
  <section class="panel chat" aria-labelledby="chatTitle">
    <h2 id="chatTitle" class="sr">Conversation</h2>
    <div class="log" id="log" role="log" aria-live="polite"></div>
    <div class="chips" aria-label="Suggestions">
      <button class="btn" type="button" data-say="status">Status</button>
      <button class="btn" type="button" data-say="my tasks">My tasks</button>
      <button class="btn" type="button" data-say="help">Help</button>
    </div>
    <form id="form" autocomplete="off">
      <label class="sr" for="input">Message to Kiyara</label>
      <input id="input" maxlength="2000" placeholder="Ask Kiyara — try “status”">
      <button class="btn primary" type="submit">Send</button>
    </form>
  </section>
</div>
<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var STATE_TEXT = { idle: "Ready", working: "Working", approval_needed: "Approval needed", completed: "Completed", blocked: "Blocked" };

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, { method: opts.method || "GET", headers: { "Content-Type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "same-origin" });
    if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent("/kiyara"); throw new Error("Sign in required"); }
    var data = {}; try { data = await res.json(); } catch (e) {}
    if (!res.ok) { var err = new Error(data.error || ("Request failed (" + res.status + ")")); err.status = res.status; throw err; }
    return data;
  }

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function say(who, text, extra) {
    extra = extra || {};
    var m = el("div", "msg " + who + (extra.error ? " error" : ""), text);
    if (extra.evidence && extra.evidence.length) {
      var ev = el("div", "evidence");
      extra.evidence.forEach(function (item) {
        if (!/^\\/[a-z0-9/_\\-.%]*$/i.test(item.href || "")) return;
        var a = el("a", null, item.label); a.href = item.href; ev.appendChild(a);
      });
      m.appendChild(ev);
    }
    if (extra.proposal) m.appendChild(confirmCard(extra.proposal));
    $("log").appendChild(m);
    $("log").scrollTop = $("log").scrollHeight;
    return m;
  }

  function confirmCard(p) {
    var box = el("div", "confirm");
    var yes = el("button", "btn primary", "Confirm " + p.action); yes.type = "button";
    var no = el("button", "btn", "Cancel"); no.type = "button";
    yes.onclick = async function () {
      yes.disabled = no.disabled = true;
      try {
        var r = await api("/api/kiyara/action", { method: "POST", body: { targetType: p.targetType, target: p.target, action: p.action, confirm: true } });
        say("kiyara", r.reply, { evidence: [{ label: "Request " + r.request.id, href: "/api/kiyara/requests/" + encodeURIComponent(r.request.id) }] });
        follow(r.request.id, "requested");
      } catch (e) { say("kiyara", e.message, { error: true }); }
    };
    no.onclick = function () { yes.disabled = no.disabled = true; say("kiyara", "Cancelled. Nothing was changed."); };
    box.appendChild(yes); box.appendChild(no);
    return box;
  }

  // Narrates a control request only when its stored state changes.
  function follow(id, last) {
    var tries = 0;
    var timer = setInterval(async function () {
      tries++;
      try {
        var r = await api("/api/kiyara/requests/" + encodeURIComponent(id));
        if (r.request.status !== last) { last = r.request.status; say("kiyara", r.reply); }
        if (["completed", "failed", "expired"].indexOf(r.request.status) >= 0 || tries > 60) clearInterval(timer);
      } catch (e) { clearInterval(timer); }
    }, 3000);
  }

  function renderState(s) {
    $("avatar").dataset.state = s.state; $("state").dataset.state = s.state;
    $("state").textContent = STATE_TEXT[s.state] || s.state;
    var f = $("facts"); f.textContent = "";
    function row(label, value) { var d = el("div"); d.appendChild(document.createTextNode(label + ": ")); d.appendChild(el("b", null, value)); f.appendChild(d); }
    if (s.focus) row("Following", s.focus.title + " (" + String(s.focus.status).replace(/_/g, " ") + ")");
    row("Your missions", s.counts.active + " active · " + s.counts.waiting + " waiting · " + s.counts.stopped + " stopped");
    if (s.systems) {
      var names = { builder: "System A", auditor: "System B", gateway: "Model gateway" };
      Object.keys(names).forEach(function (k) { row(names[k], String(s.systems.processes[k].status).replace(/_/g, " ")); });
      if (s.systems.emergency.engaged) row("Emergency stop", "engaged");
    }
    row("Observed", new Date(s.observedAt).toLocaleTimeString());
  }

  async function refresh() { try { renderState(await api("/api/kiyara/state")); } catch (e) { $("state").textContent = "Offline — " + e.message; $("state").dataset.state = "blocked"; } }

  async function send(text) {
    text = String(text || "").trim(); if (!text) return;
    say("user", text);
    try { var r = await api("/api/kiyara/message", { method: "POST", body: { text: text } }); say("kiyara", r.reply, r); }
    catch (e) { say("kiyara", e.message, { error: true }); }
    refresh();
  }

  $("form").addEventListener("submit", function (e) { e.preventDefault(); var v = $("input").value; $("input").value = ""; send(v); });
  document.querySelectorAll("[data-say]").forEach(function (b) { b.addEventListener("click", function () { send(b.dataset.say); }); });
  say("kiyara", "Hi, I'm Kiyara. I can tell you what RazeKit DEV is doing, from its live records. Ask for “status” or “help”.");
  refresh();
  setInterval(refresh, 15000);
})();
</script>
</body>
</html>`;
