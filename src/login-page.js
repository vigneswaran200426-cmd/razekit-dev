// The sign-in page. Served before identity is resolved, like the Control Center
// shell; everything it does goes through /auth/*. It never stores a token in
// script-readable storage: the session lives in an HttpOnly cookie.
export const loginPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · RazeKit DEV</title>
<style>
:root{--bg:#07111f;--panel:#0d1a2b;--panel-2:#101f33;--line:rgba(181,214,255,.12);--line-strong:rgba(181,214,255,.2);--text:#eef6ff;--muted:#8fa5bf;--accent:#50c7ff;--danger:#ff7f9c;--radius:18px}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:radial-gradient(circle at 20% -10%,rgba(80,199,255,.11),transparent 32%),radial-gradient(circle at 95% 0%,rgba(122,100,255,.09),transparent 30%),var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.28)}
h1{margin:0 0 4px;font-size:20px}
p.lede{margin:0 0 20px;color:var(--muted)}
label{display:block;margin:14px 0 6px;color:var(--muted);font-size:13px}
input{width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line-strong);background:var(--panel-2);color:var(--text);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;margin-top:20px;padding:11px 14px;border:0;border-radius:12px;background:var(--accent);color:#04121d;font:600 14px/1 inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
.error{margin-top:14px;color:var(--danger);min-height:1.5em}
.switch{margin-top:16px;color:var(--muted);font-size:13px;text-align:center}
.switch a{color:var(--accent);cursor:pointer}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
  <form class="card" id="form" novalidate>
    <h1 id="title">Sign in to RazeKit DEV</h1>
    <p class="lede" id="lede">Use your RazeKit DEV account.</p>
    <div id="tokenRow" hidden>
      <label for="token">Bootstrap token</label>
      <input id="token" name="token" autocomplete="off">
    </div>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required minlength="12">
    <button type="submit" id="submit">Sign in</button>
    <div class="error" id="error" role="alert"></div>
    <div class="switch" id="signupSwitch" hidden><a id="toggle">Create an account</a></div>
  </form>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let mode = "login";

  function setMode(next) {
    mode = next;
    $("tokenRow").hidden = mode !== "bootstrap";
    $("title").textContent = mode === "bootstrap" ? "Set up RazeKit DEV" : mode === "signup" ? "Create your account" : "Sign in to RazeKit DEV";
    $("lede").textContent = mode === "bootstrap" ? "Create the owner account for this deployment." : mode === "signup" ? "Passwords need at least 12 characters." : "Use your RazeKit DEV account.";
    $("submit").textContent = mode === "login" ? "Sign in" : "Create account";
    $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("toggle").textContent = mode === "signup" ? "I already have an account" : "Create an account";
  }

  async function post(path, payload) {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  $("toggle").addEventListener("click", () => setMode(mode === "signup" ? "login" : "signup"));

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("error").textContent = "";
    $("submit").disabled = true;
    const email = $("email").value.trim();
    const password = $("password").value;
    try {
      if (mode === "bootstrap") {
        await post("/auth/bootstrap", { token: $("token").value.trim(), email, password });
        await post("/auth/login", { email, password });
      } else if (mode === "signup") {
        await post("/auth/signup", { email, password });
      } else {
        await post("/auth/login", { email, password });
      }
      const next = new URLSearchParams(location.search).get("next");
      location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (error) {
      $("error").textContent = error.message;
    } finally {
      $("submit").disabled = false;
    }
  });

  fetch("/auth/status").then((r) => r.json()).then((status) => {
    if (status.needsBootstrap) setMode("bootstrap");
    $("signupSwitch").hidden = status.needsBootstrap || !status.signupOpen;
  }).catch(() => {});
})();
</script>
</body>
</html>`;
