import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const REPO = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const PROVIDER = providerConfig(process.env);
const BRANCH = "autobuild/razekit-dev-continuous";
const PR_TITLE = "RazeKit DEV Continuous Self-Build (review required)";
const BACKLOG = "self-build/backlog.json";
const PROGRESS = "self-build/progress.json";
const DENIED = [
  ".github/**", "scripts/**", "self-build/**", "package.json",
  "package-lock.json", "npm-shrinkwrap.json", "render.yaml", ".env",
  ".env.*", "src/auth.js", "src/admin-control.js", "src/credential-vault.js",
  "src/permission-broker.js", "src/store.js", "src/model-providers.js",
  "src/adapters/groq-openai-adapter.js", "src/budget-manager.js", "src/jev-budget.js"
];

const DYNAMIC_SAFE_FILES = [
  "src/worker-agent.js", "src/production-runtime.js", "src/runtime-coordinator.js",
  "src/observability.js", "src/app-web-executor.js", "src/game-executor.js",
  "src/verification.js", "src/dashboard-page.js", "src/server.js", "README.md"
];

/**
 * Which model provider this run uses. Groq when its key is configured;
 * otherwise GitHub Models, reached with the workflow's own GITHUB_TOKEN
 * (permission `models: read`) at no cost within its free rate limits. Never a
 * paid provider, and never a fallback from one provider to the other mid-run.
 */
export function providerConfig(env = process.env) {
  if (env.GROQ_API_KEY) {
    return { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", model: env.GROQ_MODEL || "openai/gpt-oss-120b", key: env.GROQ_API_KEY, headers: {}, extra: { reasoning_effort: "low" } };
  }
  if (env.RAZEKIT_AUTOBUILD_PROVIDER === "github-models" && env.GITHUB_TOKEN) {
    return { name: "github-models", url: "https://models.github.ai/inference/chat/completions", model: env.GITHUB_MODELS_MODEL || "openai/gpt-4.1", key: env.GITHUB_TOKEN, headers: { accept: "application/vnd.github+json", "x-github-api-version": env.GITHUB_MODELS_API_VERSION || "2026-03-10" }, extra: {} };
  }
  return { name: "none" };
}

export function isSafeRepoPath(file, patterns = []) {
  const value = String(file || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value.includes("\0")) return false;
  if (path.posix.normalize(value) !== value || value.split("/").some(part => part === "." || part === "..")) return false;
  if (DENIED.some(pattern => matches(value, pattern))) return false;
  return patterns.some(pattern => matches(value, pattern));
}
function matches(file, pattern) {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}
export function parseModelPatch(text) {
  const value = String(text || "").trim();
  const item = JSON.parse(value);
  const summary = String(item?.summary || "").trim();
  const patch = String(item?.patch || "");
  if (!summary || !patch.trim()) throw new Error("Model output must include summary and a non-empty patch");
  if (patch.length > 100000) throw new Error("Patch exceeds 100 KB");
  return { summary, patch };
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT, encoding: "utf8", timeout: opts.timeout || 120000,
    maxBuffer: 8 * 1024 * 1024, env: opts.env || process.env, input: opts.input
  });
  if (r.error) throw new Error(cmd + " failed: " + r.error.message);
  if (!opts.allowFailure && r.status !== 0) {
    const isPush = args.some(x => String(x).startsWith("http.extraheader="));
    const label = isPush ? "git push (credentials redacted)" : cmd + " " + args.join(" ");
    throw new Error(label + " exited " + r.status + "\n" + (String(r.stdout || "") + "\n" + String(r.stderr || "")).trim().slice(-8000));
  }
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function log(s) { console.log("[razekit-autobuilder] " + s); }
function loadJson(file, fallback) {
  const p = path.join(ROOT, file);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
}
async function gh(p, options = {}) {
  const r = await fetch("https://api.github.com" + p, {
    ...options, headers: {
      authorization: "Bearer " + TOKEN, accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const bodyText = await r.text();
  let data = {};
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  if (!r.ok) throw new Error("GitHub API HTTP " + r.status + ": " + String(data.message || "request failed"));
  return data;
}
async function askModel(system, user, maxTokens = 2800) {
  const r = await fetch(PROVIDER.url, {
    method: "POST",
    headers: { authorization: "Bearer " + PROVIDER.key, "content-type": "application/json", ...PROVIDER.headers },
    body: JSON.stringify({
      model: PROVIDER.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens, response_format: { type: "json_object" }, ...PROVIDER.extra
    }),
    signal: AbortSignal.timeout(150000)
  });
  if (!r.ok) {
    let code = "unspecified";
    try { const e = await r.json(); code = e?.error?.code || e?.error?.type || code; } catch {}
    const retry = r.headers.get("retry-after");
    throw new Error(PROVIDER.name + " HTTP " + r.status + " (" + code + ")" + (retry ? "; retry-after=" + retry + "s" : "") + "; paid fallback disabled");
  }
  // Read as text first: a non-JSON answer is reported as what it was, not as
  // a JSON syntax error. The response body holds no credential.
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    const where = r.redirected ? " after a redirect to " + new URL(r.url).origin + new URL(r.url).pathname : "";
    if (PROVIDER.name === "github-models") log("Diagnosis: " + await diagnoseGithubModels());
    throw new Error(PROVIDER.name + " answered HTTP " + r.status + " " + (r.headers.get("content-type") || "no content-type") + where + " with a non-JSON body: " + JSON.stringify(text.slice(0, 200)));
  }
  const choice = data.choices?.[0];
  if (!choice || choice.finish_reason === "length") throw new Error(PROVIDER.name + " response was missing or truncated");
  if (data.usage) log("Model " + PROVIDER.name + "/" + PROVIDER.model + " usage: " + (data.usage.prompt_tokens ?? "?") + " in, " + (data.usage.completion_tokens ?? "?") + " out");
  return String(choice.message?.content || "");
}
/** What the GitHub Models service says about itself, for an unusable answer. No secret is printed. */
async function diagnoseGithubModels() {
  const parts = [];
  try {
    const c = await fetch("https://models.github.ai/catalog/models", { headers: { authorization: "Bearer " + PROVIDER.key, accept: "application/vnd.github+json", ...PROVIDER.headers }, signal: AbortSignal.timeout(20000) });
    const text = await c.text();
    let count = null; try { const j = JSON.parse(text); count = Array.isArray(j) ? j.length : null; } catch {}
    parts.push("catalog HTTP " + c.status + " " + (c.headers.get("content-type") || "") + (count != null ? ", " + count + " models" : ", body " + JSON.stringify(text.slice(0, 80))));
  } catch (e) { parts.push("catalog error " + e.message); }
  try {
    const m = await fetch(PROVIDER.url, { method: "POST", headers: { authorization: "Bearer " + PROVIDER.key, "content-type": "application/json", ...PROVIDER.headers }, body: JSON.stringify({ model: PROVIDER.model, messages: [{ role: "user", content: "Reply with the word ready." }], max_tokens: 5 }), signal: AbortSignal.timeout(30000) });
    const text = await m.text();
    parts.push("minimal request HTTP " + m.status + " " + (m.headers.get("content-type") || "") + " body " + JSON.stringify(text.slice(0, 120)));
  } catch (e) { parts.push("minimal request error " + e.message); }
  return parts.join("; ");
}

async function findPRs() {
  const all = await gh("/repos/" + REPO + "/pulls?state=all&per_page=100&sort=updated&direction=desc");
  return all.filter(p => p.head?.ref === BRANCH && p.base?.ref === "main");
}
function assertClean() {
  if (run("git", ["status", "--porcelain"]).stdout.trim()) throw new Error("Unexpected dirty checkout; refusing to continue");
}
async function checkoutBranch(openPr) {
  run("git", ["fetch", "--no-tags", "origin", "main"]);
  const exists = run("git", ["ls-remote", "--heads", "origin", "refs/heads/" + BRANCH], { allowFailure: true }).stdout.trim();
  if (openPr || exists) {
    run("git", ["fetch", "--no-tags", "origin", BRANCH]);
    run("git", ["switch", "--force-create", BRANCH, "origin/" + BRANCH]);
  } else {
    run("git", ["switch", "--create", BRANCH, "origin/main"]);
  }
}
function contextFor(item) {
  const out = [];
  let remaining = 12000;
  for (const file of item.contextFiles || []) {
    if (!isSafeRepoPath(file, item.allowedPaths)) continue;
    const p = path.join(ROOT, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const chunk = text.slice(0, Math.min(4000, remaining));
    out.push("\n--- " + file + (chunk.length < text.length ? " (truncated)" : "") + " ---\n" + chunk);
    remaining -= chunk.length;
    if (remaining <= 0) break;
  }
  return out.join("\n");
}
function validatePatch(patch, patterns) {
  if (/GIT binary patch|new file mode 120000|old mode 120000|rename from |rename to |copy from |copy to /i.test(patch)) throw new Error("Binary, symlink, rename and copy patches are denied");
  const headers = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  if (!headers.length) throw new Error("No unified diff headers found");
  for (const h of headers) {
    if (h[1] !== h[2] || !isSafeRepoPath(h[2], patterns)) throw new Error("Patch attempts to modify a disallowed path: " + h[2]);
  }
}
function changedPaths(patterns) {
  const rows = run("git", ["status", "--porcelain=v1", "-z"]).stdout.split("\0").filter(Boolean);
  const out = [];
  for (const row of rows) {
    const state = row.slice(0, 2);
    const file = row.slice(3);
    if (!file) continue;
    if (state.includes("D") || state.includes("R") || state.includes("C") || state.includes("U")) throw new Error("Deletion, rename, copy or conflict denied: " + file);
    if (file === PROGRESS) continue;
    if (!isSafeRepoPath(file, patterns)) throw new Error("Disallowed changed path: " + file);
    out.push(file);
  }
  return [...new Set(out)];
}
function testEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTHORIZATION/i.test(key) || key.startsWith("ACTIONS_")) continue;
    env[key] = value;
  }
  return { ...env, CI: "true", RAZEKIT_MODEL_MODE: "test" };
}
function sandboxTests() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1001;
  const gid = typeof process.getgid === "function" ? process.getgid() : 121;
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], { timeout: 120000, env: testEnv() });
  run("docker", [
    "run", "--rm", "--network", "none", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=256", "--memory=2g", "--cpus=2", "--user", uid + ":" + gid,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m,uid=" + uid + ",gid=" + gid,
    // .git read-only: the candidate cannot plant a hook that git would run on
    // the host at push time, where the token is in reach.
    "--volume", ROOT + ":/work", "--volume", path.join(ROOT, ".git") + ":/work/.git:ro", "--workdir", "/work",
    "--env", "CI=true", "--env", "RAZEKIT_MODEL_MODE=test",
    "node:24-bookworm-slim", "npm", "test"
  ], { timeout: 240000, env: testEnv() });
}
async function push() {
  const auth = Buffer.from("x-access-token:" + TOKEN).toString("base64");
  run("git", ["-c", "core.hooksPath=/dev/null", "-c", "http.extraheader=AUTHORIZATION: basic " + auth, "push", "origin", "HEAD:refs/heads/" + BRANCH], { timeout: 120000 });
}
async function ensurePR(summary) {
  const prs = await findPRs();
  const open = prs.find(p => p.state === "open");
  if (open) { log("Updated draft PR #" + open.number); return; }
  if (prs.length) throw new Error("The continuous self-build PR was closed or merged; inspect it before continuing");
  const body = "Draft PR updated by the scheduled RazeKit DEV builder (GitHub Actions, " + PROVIDER.name + " / " + PROVIDER.model + "). " +
    "This is a scheduled job, not a persistent 24/7 worker.\n\nLatest increment: " + summary +
    "\n\nSafety: dedicated autobuild branch; no auto-merge/deploy; tests run in a network-isolated container without API credentials; no paid-provider fallback.";
  const pr = await gh("/repos/" + REPO + "/pulls", {
    method: "POST",
    body: JSON.stringify({ title: PR_TITLE, head: BRANCH, base: "main", body, draft: true })
  });
  log("Created draft PR #" + pr.number + ": " + pr.html_url);
}
async function discoverNextTask(existingItems, initialBacklog) {
  const grep = run("git", [
    "grep", "-n", "-E",
    "TODO|not implemented|not configured|placeholder|NOT_STARTED|production deployment still requires|is not implemented",
    "--", "src", "README.md"
  ], { allowFailure: true }).stdout.slice(0, 7000);
  const readme = existsSync(path.join(ROOT, "README.md")) ? readFileSync(path.join(ROOT, "README.md"), "utf8").slice(0, 5000) : "";
  const system = [
    "You discover the next small, real missing capability in RazeKit DEV.",
    "Return JSON only. Do not invent APIs or claim unfinished work is complete.",
    "Choose one achievable feature evidenced by source or docs, not a UI-only redesign.",
    "Never choose auth, permissions, secret handling, billing/budgets, model-provider wiring, storage schema, self-builder, CI or deployment config.",
    "Editable source files are limited to: " + DYNAMIC_SAFE_FILES.join(", ") + " and tests under test/.",
    "If no suitable incomplete task is evidenced, return {\"done\":true,\"reason\":\"...\"}.",
    "Otherwise return {\"done\":false,\"id\":\"short-kebab-case\",\"title\":\"...\",\"goal\":\"...\",\"acceptanceCriteria\":[\"...\",\"...\"],\"contextFiles\":[\"permitted source file\", \"optional second permitted source file\"]}."
  ].join(" ");
  const user = [
    "Already completed/queued tasks: " + JSON.stringify(existingItems.map(item => item.id)),
    "Initial planned tasks: " + JSON.stringify(initialBacklog.map(item => ({ id: item.id, title: item.title }))),
    "README excerpt:\n" + readme,
    "Source TODO/placeholder search:\n" + grep,
    "Possible context files:\n" + DYNAMIC_SAFE_FILES.join("\n")
  ].join("\n\n");
  let result;
  try { result = JSON.parse(await askModel(system, user, 1000)); }
  catch { throw new Error("Model failed to return valid JSON for backlog discovery"); }
  if (result.done === true) return { done: true, reason: String(result.reason || "no task evidence") };
  const id = String(result.id || "").trim();
  const title = String(result.title || "").trim();
  const goal = String(result.goal || "").trim();
  const criteria = Array.isArray(result.acceptanceCriteria) ? result.acceptanceCriteria.map(String).slice(0, 5) : [];
  const known = new Set(existingItems.map(item => item.id));
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(id) || known.has(id)) throw new Error("Discovered task has an invalid or duplicate id");
  if (!title || title.length > 140 || !goal || goal.length > 1200 || criteria.length < 2) throw new Error("Discovered task is incomplete");
  const contextFiles = [...new Set((Array.isArray(result.contextFiles) ? result.contextFiles : []).map(String).filter(file => DYNAMIC_SAFE_FILES.includes(file)))].slice(0, 3);
  if (!contextFiles.length) throw new Error("Discovered task selected no permitted context files");
  const allowedPaths = [...new Set(contextFiles.filter(file => file !== "README.md").concat(["test/**", "README.md"]))];
  return { done: false, item: { id, title, goal, acceptanceCriteria: criteria, contextFiles, allowedPaths } };
}

async function main() {
  if (PROVIDER.name === "none") throw new Error("No model provider: add GROQ_API_KEY under Settings > Secrets and variables > Actions, or enable GitHub Models (RAZEKIT_AUTOBUILD_PROVIDER=github-models with permission models: read)");
  log("Provider: " + PROVIDER.name + " / " + PROVIDER.model);
  if (!TOKEN) throw new Error("GitHub Actions token is unavailable");
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) throw new Error("GITHUB_REPOSITORY is missing");
  const backlog = loadJson(BACKLOG, []);
  const dynamicBacklog = loadJson("self-build/dynamic-backlog.json", []);
  if (!Array.isArray(backlog) || backlog.length === 0 || !Array.isArray(dynamicBacklog)) throw new Error("Backlog files must be JSON arrays");
  const tasks = [...backlog, ...dynamicBacklog];
  const prs = await findPRs();
  const open = prs.find(p => p.state === "open") || null;
  if (!open && prs.length) throw new Error("Continuous build PR was closed or merged. Inspect before continuing");
  assertClean();
  await checkoutBranch(open);
  assertClean();
  const progress = loadJson(PROGRESS, { version: 1, nextIndex: 0, completed: [], lastTaskId: null, lastSuccessfulRunAt: null });
  while (progress.nextIndex < tasks.length && progress.completed.includes(tasks[progress.nextIndex]?.id)) progress.nextIndex++;
  if (progress.nextIndex >= tasks.length) {
    const discovered = await discoverNextTask(tasks, backlog);
    if (discovered.done) {
      log("No safe, evidenced task discovered: " + discovered.reason);
      return;
    }
    dynamicBacklog.push(discovered.item);
    writeFileSync(path.join(ROOT, "self-build/dynamic-backlog.json"), JSON.stringify(dynamicBacklog, null, 2) + "\n", "utf8");
    run("git", ["add", "--", "self-build/dynamic-backlog.json"]);
    run("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=razekit-dev-autobuilder[bot]", "-c", "user.email=autobuilder@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "-m", "[autobuild] queue task: " + discovered.item.id]);
    await push();
    await ensurePR("Queued the next evidence-based improvement: " + discovered.item.title);
    log("Queued a new, scoped task. It will be implemented during a later scheduled run.");
    return;
  }
  const task = tasks[progress.nextIndex];
  if (!task?.id || !task?.title || !task?.goal || !Array.isArray(task.allowedPaths) || !Array.isArray(task.contextFiles)) throw new Error("Malformed backlog entry " + progress.nextIndex);
  log("Working on " + task.id + ": " + task.title);
  const context = contextFor(task);
  const system = [
    "You implement one small production-oriented change for RazeKit DEV.",
    "Return only a JSON object with string fields summary and patch. patch is a unified git diff accepted by git apply.",
    "No markdown fences or prose outside JSON. Do not invent API behavior.",
    "Preserve behavior, add useful tests, and do not evade tests.",
    "Do not change security, auth, permissions, billing/budget, model-provider, self-builder, CI, manifest, deployment, backlog or progress files.",
    "No binary files, symlinks, renames, deletions, generated outputs or network calls.",
    "The candidate is tested in a network-isolated container without credentials. If unable to safely implement, return summary starting BLOCKED and an empty patch."
  ].join(" ");
  const user = [
    "TASK: " + task.id + " — " + task.title,
    "GOAL: " + task.goal,
    "ACCEPTANCE:\n" + (task.acceptanceCriteria || []).map((x, i) => (i + 1) + ". " + x).join("\n"),
    "ALLOWED PATHS:\n" + task.allowedPaths.join("\n"),
    "SOURCE:\n" + context,
    "Keep the diff small enough to test and use no more than 2800 output tokens."
  ].join("\n\n");
  const temp = mkdtempSync(path.join(os.tmpdir(), "rk-autobuild-"));
  try {
    const output = parseModelPatch(await askModel(system, user));
    if (output.summary.startsWith("BLOCKED")) { log("Blocked: " + output.summary); return; }
    validatePatch(output.patch, task.allowedPaths);
    const patchFile = path.join(temp, "candidate.patch");
    writeFileSync(patchFile, output.patch, "utf8");
    run("git", ["apply", "--check", "--whitespace=error-all", patchFile]);
    run("git", ["apply", "--whitespace=error-all", patchFile]);
    const changed = changedPaths(task.allowedPaths);
    if (!changed.length) throw new Error("No allowed files changed");
    run("git", ["diff", "--check"]);
    log("Running the full test suite in a network-isolated container without model or GitHub credentials");
    sandboxTests();
    progress.nextIndex++;
    progress.completed = [...new Set([...(progress.completed || []), task.id])];
    progress.lastTaskId = task.id;
    progress.lastSuccessfulRunAt = new Date().toISOString();
    writeFileSync(path.join(ROOT, PROGRESS), JSON.stringify(progress, null, 2) + "\n", "utf8");
    run("git", ["add", "--", ...changed, PROGRESS]);
    run("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=razekit-dev-autobuilder[bot]", "-c", "user.email=autobuilder@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "-m", "[autobuild] " + task.id + ": " + task.title]);
    await push();
    await ensurePR(output.summary);
    log("Task passed tests and was added to the draft PR. Main was not pushed or deployed.");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error("[razekit-autobuilder] STOPPED: " + err.message);
    process.exitCode = 1;
  });
}
