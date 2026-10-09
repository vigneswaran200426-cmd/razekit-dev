import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractJsonObject } from "./adapters/model-json.js";
import { BUILDER_SCOPE_AREAS, builderPathAllowed, redactText } from "./ops-domain.js";
import { awaitInference, requestInference } from "./inference-gateway.js";
import { getInference, getModelConfig, recordModelTest } from "./ops-state.js";
import { NonRetryableError, TaskParked } from "./ops-supervisor.js";

// System A — the RazeKit DEV Builder.
//
// Real tools, all of them: git, node and npm run as child processes (no shell)
// inside the builder's own workspace; tests are the repository's own suite;
// the pull request is a real GitHub draft. Model output is never trusted to
// name a file — every path is checked against the task's scope area.
//
// There is no merge function and no deploy function in this module. A draft
// pull request is as far as System A can go.

const ALLOWED_COMMANDS = new Set(["git", "node", "npm", "docker"]);
const OUTPUT_CAP = 200_000;

export function runCommand(command, args, { cwd, timeoutMs = 10 * 60_000, signal = null, env = {}, input = null } = {}) {
  if (!ALLOWED_COMMANDS.has(command)) return Promise.reject(new NonRetryableError("Command not allowed: " + command));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32" && command === "npm",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME || process.env.USERPROFILE,
        USERPROFILE: process.env.USERPROFILE,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        GIT_TERMINAL_PROMPT: "0",
        npm_config_update_notifier: "false",
        ...env
      },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => { if (stdout.length < OUTPUT_CAP) stdout += chunk; });
    child.stderr.on("data", chunk => { if (stderr.length < OUTPUT_CAP) stderr += chunk; });
    if (input != null) child.stdin.end(input); else child.stdin.end();
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(signal.reason);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parses node --test's summary lines. */
export function parseNodeTestSummary(output) {
  const read = name => {
    const match = new RegExp("^[ℹ#] " + name + " (\\d+)", "m").exec(output);
    return match ? Number(match[1]) : null;
  };
  const failing = [...output.matchAll(/^✖ (.+?) \(\d/gm)].map(match => match[1]).filter(name => name !== "failing tests:");
  return { total: read("tests"), pass: read("pass"), fail: read("fail"), skipped: read("skipped"), failing: [...new Set(failing)].slice(0, 30) };
}

function repoConfig(env) {
  return {
    url: env.RAZEKIT_BUILDER_REPO_URL || "https://github.com/vigneswaran200426-cmd/razekit-dev.git",
    slug: env.RAZEKIT_BUILDER_REPO || "vigneswaran200426-cmd/razekit-dev",
    base: env.RAZEKIT_BUILDER_BASE_BRANCH || "main",
    token: env.RAZEKIT_BUILDER_GITHUB_TOKEN || null,
    testTimeoutMs: Number(env.RAZEKIT_BUILDER_TEST_TIMEOUT_MS || 20 * 60_000),
    inferenceWaitMs: Number(env.RAZEKIT_BUILDER_INFERENCE_WAIT_MS || 120_000),
    sandbox: env.RAZEKIT_BUILDER_SANDBOX || "process",
    sandboxImage: env.RAZEKIT_BUILDER_SANDBOX_IMAGE || "node:22-bookworm-slim"
  };
}

function authArgs(token) {
  if (!token) return [];
  const basic = Buffer.from("x-access-token:" + token).toString("base64");
  return ["-c", "http.extraheader=AUTHORIZATION: basic " + basic];
}

async function git(ctx, args, options = {}) {
  const result = await runCommand("git", args, { cwd: options.cwd || ctx.repoDir, signal: ctx.signal, timeoutMs: options.timeoutMs || 5 * 60_000 });
  if (result.code !== 0 && !options.allowFailure) {
    // The args may carry an auth header; never echo them.
    throw new Error("git " + args.filter(arg => !arg.startsWith("http.extraheader")).slice(0, 3).join(" ") + " exited " + result.code + ": " + redactText(result.stderr).slice(-1500));
  }
  return result;
}

/** A persistent clone in the builder's workspace, reset to the remote base. */
async function prepareRepo(ctx, cfg) {
  ctx.repoDir = path.join(ctx.workspaceRoot, "repo");
  if (!existsSync(path.join(ctx.repoDir, ".git"))) {
    await mkdir(ctx.workspaceRoot, { recursive: true });
    await runCommand("git", [...authArgs(cfg.token), "clone", "--no-tags", cfg.url, ctx.repoDir], { cwd: ctx.workspaceRoot, signal: ctx.signal, timeoutMs: 10 * 60_000 })
      .then(result => { if (result.code !== 0) throw new Error("git clone failed: " + redactText(result.stderr).slice(-800)); });
  }
  await git(ctx, [...authArgs(cfg.token), "fetch", "--no-tags", "--prune", "origin"]);
  await git(ctx, ["checkout", "--force", "-B", cfg.base, "origin/" + cfg.base]);
  await git(ctx, ["clean", "-fdx", "-e", "node_modules"]);
  const head = (await git(ctx, ["rev-parse", "HEAD"])).stdout.trim();
  return head;
}

/**
 * Model-written code runs in a container when the host has Docker
 * (RAZEKIT_BUILDER_SANDBOX=docker, set on the control plane): no network, no
 * capabilities, an unprivileged user, bounded memory, CPU and processes, and
 * only the workspace mounted. Without it the run is a child process of the
 * builder's own restricted Unix user.
 */
function testCommand(ctx, cfg) {
  if (cfg.sandbox === "docker") {
    return ["docker", ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000", "--memory", "2g", "--cpus", "1.5", "--pids-limit", "512", "--read-only", "--tmpfs", "/tmp",
      "-e", "RAZEKIT_STORE=json", "-e", "NODE_ENV=test", "-e", "HOME=/tmp",
      "-v", ctx.repoDir + ":/work", "-w", "/work", cfg.sandboxImage, "npm", "test"]];
  }
  return ["npm", ["test"]];
}

async function runTests(ctx, cfg) {
  const started = Date.now();
  const [command, args] = testCommand(ctx, cfg);
  const result = await runCommand(command, args, { cwd: ctx.repoDir, signal: ctx.signal, timeoutMs: cfg.testTimeoutMs, env: { RAZEKIT_STORE: "json", NODE_ENV: "test" } });
  const summary = parseNodeTestSummary(result.stdout + "\n" + result.stderr);
  return { exitCode: result.code, passed: result.code === 0, durationMs: Date.now() - started, sandbox: cfg.sandbox, ...summary, tail: redactText((result.stdout + result.stderr).slice(-4000)) };
}

/**
 * One inference step that survives the GPU being off. The request id lives in
 * the checkpoint, so a resumed task looks up the answer to the question it
 * already asked instead of asking again.
 */
async function infer(ctx, state, key, build) {
  state.requests = state.requests || {};
  if (!state.requests[key]) {
    const request = await requestInference({ requester: "builder", taskId: ctx.task.id, ...build() });
    state.requests[key] = request.id;
    await ctx.checkpointWrite("inference:" + key, state);
  }
  const request = await awaitInference(state.requests[key], { timeoutMs: ctx.inferenceWaitMs, signal: ctx.signal });
  if (request.status === "completed") return request;
  if (request.status === "failed") {
    delete state.requests[key];
    await ctx.checkpointWrite("inference-failed:" + key, state);
    throw new Error("Inference for " + key + " failed: " + request.error);
  }
  throw new TaskParked("waiting_inference", { requestId: request.id, step: key, reason: "Inference queued; the gateway has not produced an answer" }, 60_000);
}

async function readScopeFiles(ctx, scopeArea, wanted) {
  const out = [];
  let budget = 48_000;
  for (const file of wanted) {
    if (!builderPathAllowed(file, scopeArea)) continue;
    const full = path.join(ctx.repoDir, file);
    if (!existsSync(full)) continue;
    const text = await readFile(full, "utf8");
    const chunk = text.slice(0, Math.min(16_000, budget));
    out.push({ path: file, content: chunk, truncated: chunk.length < text.length });
    budget -= chunk.length;
    if (budget <= 0) break;
  }
  return out;
}

function scopeFileList(scopeArea) {
  return BUILDER_SCOPE_AREAS[scopeArea].paths.filter(item => !item.endsWith("/**"));
}

async function createDraftPullRequest(cfg, { head, title, body }) {
  const response = await fetch("https://api.github.com/repos/" + cfg.slug + "/pulls", {
    method: "POST",
    headers: {
      authorization: "Bearer " + cfg.token,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json"
    },
    body: JSON.stringify({ title, head, base: cfg.base, body, draft: true, maintainer_can_modify: false }),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("GitHub draft PR failed: HTTP " + response.status + " " + (data.message || ""));
  return { number: data.number, url: data.html_url, draft: data.draft };
}

// ── Task kinds ──────────────────────────────────────────────────────────────

async function repoInspect(ctx, cfg) {
  await ctx.progress(10, "fetching repository");
  const head = await prepareRepo(ctx, cfg);
  await ctx.checkpointWrite("repo-ready", { head });
  await ctx.progress(30, "running test suite");
  const tests = await runTests(ctx, cfg);
  await ctx.checkpointWrite("tests", { head, tests: { ...tests, tail: undefined } });
  const status = (await git(ctx, ["status", "--porcelain"])).stdout.trim();
  const log = (await git(ctx, ["log", "--oneline", "-5"])).stdout.trim().split("\n");
  return {
    summary: "Inspected " + head.slice(0, 7) + ": " + (tests.passed ? "tests pass" : "tests FAIL") + " (" + tests.pass + "/" + tests.total + " pass, " + tests.fail + " fail, " + tests.skipped + " skipped)",
    head,
    tests,
    cleanTree: status === "",
    recentCommits: log
  };
}

const PLAN_SYSTEM = "You are the planning model for RazeKit DEV's builder. Reply with one JSON object only.";
const IMPLEMENT_SYSTEM = "You are the coding model for RazeKit DEV's builder. You edit only the files you are given or permitted to create. Reply with one JSON object only.";
const REVIEW_SYSTEM = "You are the reviewing model for RazeKit DEV's builder. Judge a diff and its real test output. Reply with one JSON object only.";

async function codeChange(ctx, cfg) {
  const { task } = ctx;
  const scopeArea = task.scopeArea;
  if (!BUILDER_SCOPE_AREAS[scopeArea]) throw new NonRetryableError("code.change needs one of the seven scope areas");
  const state = ctx.checkpoint?.data ? { ...ctx.checkpoint.data } : { stage: "start", repairRound: 0 };
  const branch = "builder/" + task.id.replace(/^opstask_/, "").slice(0, 12);

  await ctx.progress(5, "preparing workspace");
  const base = await prepareRepo(ctx, cfg);
  await git(ctx, ["checkout", "-B", branch, "origin/" + cfg.base]);
  state.base = state.base || base;

  // 1. Plan (reasoning slot).
  await ctx.progress(15, "planning");
  const planRequest = await infer(ctx, state, "plan", () => ({
    slot: "reasoning",
    purpose: "builder:plan",
    maxTokens: 1500,
    format: "json",
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: "Goal: " + task.goal + "\nScope area: " + BUILDER_SCOPE_AREAS[scopeArea].label +
        "\nFiles you may change: " + scopeFileList(scopeArea).join(", ") + (BUILDER_SCOPE_AREAS[scopeArea].paths.includes("test/**") ? ", any test/*.test.js" : "") +
        "\nReturn {\"steps\":[string],\"files\":[string],\"tests\":[string],\"risks\":[string]} naming only permitted files." }
    ]
  }));
  const plan = extractJsonObject(planRequest.result.content, { what: "plan" });
  const files = (plan.files || []).filter(file => builderPathAllowed(file, scopeArea)).slice(0, 6);
  if (!files.length) throw new NonRetryableError("The plan named no file inside scope area " + scopeArea);
  state.plan = { steps: plan.steps, files };

  // 2. Implement, test, review — with at most two repair rounds.
  let tests = null;
  let review = null;
  for (let round = state.repairRound || 0; round <= 2; round += 1) {
    state.repairRound = round;
    await ctx.progress(30 + round * 15, round ? "repair round " + round : "implementing");
    const current = await readScopeFiles(ctx, scopeArea, files);
    const implRequest = await infer(ctx, state, "implement-" + round, () => ({
      slot: "coding",
      purpose: "builder:implement",
      maxTokens: 8000,
      format: "json",
      messages: [
        { role: "system", content: IMPLEMENT_SYSTEM },
        { role: "user", content: "Goal: " + task.goal + "\nPlan: " + JSON.stringify(state.plan.steps) +
          (round && tests ? "\nPrevious attempt failed. Test output tail:\n" + tests.tail + "\nReview issues: " + JSON.stringify(review?.issues || []) : "") +
          "\nCurrent files:\n" + current.map(file => "--- " + file.path + (file.truncated ? " (truncated)" : "") + " ---\n" + file.content).join("\n") +
          "\nReturn {\"summary\":string,\"edits\":[{\"path\":string,\"content\":string}]} with the complete new content of each changed file." }
      ]
    }));
    const impl = extractJsonObject(implRequest.result.content, { what: "implementation" });
    const edits = Array.isArray(impl.edits) ? impl.edits : [];
    if (!edits.length) throw new Error("The coding model proposed no edits");
    for (const edit of edits) {
      if (!builderPathAllowed(edit.path, scopeArea)) throw new NonRetryableError("Refused edit outside scope area " + scopeArea + ": " + edit.path);
      if (typeof edit.content !== "string" || edit.content.length > 200_000) throw new NonRetryableError("Edit for " + edit.path + " has no usable content");
      const full = path.join(ctx.repoDir, edit.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, edit.content);
    }
    state.summary = String(impl.summary || task.title).slice(0, 300);
    await ctx.progress(55 + round * 10, "running tests");
    tests = await runTests(ctx, cfg);
    const diff = (await git(ctx, ["diff", "--stat"])).stdout + "\n" + (await git(ctx, ["diff"])).stdout.slice(0, 30_000);
    await ctx.checkpointWrite("implemented-" + round, { ...state, tests: { ...tests, tail: undefined } });

    const reviewRequest = await infer(ctx, state, "review-" + round, () => ({
      slot: "reasoning",
      purpose: "builder:review",
      maxTokens: 1500,
      format: "json",
      messages: [
        { role: "system", content: REVIEW_SYSTEM },
        { role: "user", content: "Goal: " + task.goal + "\nDiff:\n" + diff + "\nReal test result: exit " + tests.exitCode + ", " + tests.pass + "/" + tests.total + " pass, failing: " + JSON.stringify(tests.failing) +
          "\nReturn {\"verdict\":\"approve\"|\"revise\"|\"reject\",\"issues\":[string]}. Approve only if the goal is met and tests pass." }
      ]
    }));
    review = extractJsonObject(reviewRequest.result.content, { what: "review" });
    if (tests.passed && review.verdict === "approve") break;
    if (review.verdict === "reject") break;
  }

  if (!tests?.passed || review?.verdict !== "approve") {
    return { summary: "No pull request: " + (tests?.passed ? "review " + review?.verdict : "tests failed"), outcome: "not_submitted", tests: { ...tests, tail: tests?.tail?.slice(-1500) }, review };
  }

  // 3. Commit, push, draft PR. Never merged here.
  await ctx.progress(90, "opening draft pull request");
  await git(ctx, ["add", "--", ...files.filter(file => existsSync(path.join(ctx.repoDir, file)))]);
  await runCommand("git", ["-c", "user.name=RazeKit DEV Builder", "-c", "user.email=builder@razekit.invalid", "commit", "-m", "builder: " + state.summary + "\n\nTask " + task.id + " (" + scopeArea + "). Tests: " + tests.pass + "/" + tests.total + " pass."], { cwd: ctx.repoDir, signal: ctx.signal });
  const commit = (await git(ctx, ["rev-parse", "HEAD"])).stdout.trim();
  await ctx.checkpointWrite("committed", { ...state, commit, branch });
  if (!cfg.token) {
    throw new NonRetryableError("Committed " + commit.slice(0, 7) + " on " + branch + " in the builder workspace, but RAZEKIT_BUILDER_GITHUB_TOKEN is not configured, so no branch was pushed and no draft PR opened");
  }
  await git(ctx, [...authArgs(cfg.token), "push", "--force-with-lease", "origin", branch + ":" + branch]);
  const pr = await createDraftPullRequest(cfg, {
    head: branch,
    title: "[System A] " + state.summary,
    body: "Opened by the RazeKit DEV Builder (System A) for task `" + task.id + "` in scope **" + BUILDER_SCOPE_AREAS[scopeArea].label + "**.\n\n" +
      "Goal: " + task.goal + "\n\nTests: " + tests.pass + "/" + tests.total + " pass, " + tests.fail + " fail.\nReviewer verdict: " + review.verdict +
      "\n\nDraft only — System A never merges or deploys. Review required."
  });
  return { summary: "Draft PR #" + pr.number + " opened: " + state.summary, outcome: "draft_pr", commit, branch, pullRequest: pr, tests: { ...tests, tail: undefined }, review };
}

// ── Model acceptance tests (run on real inference only) ─────────────────────

const FIXTURE = {
  "package.json": JSON.stringify({ name: "slug-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2),
  "src/slug.js": "export function slugify(text) {\n  return text.toLowerCase().replace(' ', '-');\n}\n",
  "test/slug.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.js';\n\ntest('slugify replaces every space and trims', () => {\n  assert.equal(slugify('  Hello Big World '), 'hello-big-world');\n});\n"
};

const CODING_TOOLS = [
  { type: "function", function: { name: "list_files", description: "List files in the repository", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Replace a file's content", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_tests", description: "Run npm test and return the output", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "finish", description: "Report the change and the test result", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } }
];

async function listFixture(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...await listFixture(dir, rel)); else out.push(rel);
  }
  return out;
}

function fixturePath(dir, rel) {
  const value = String(rel || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value.split("/").includes("..")) throw new Error("Path outside the fixture: " + rel);
  return path.join(dir, value);
}

async function codingTest(ctx) {
  const config = await getModelConfig();
  const model = config.slots.coding.model;
  const dir = path.join(ctx.workspace, "fixture");
  const state = ctx.checkpoint?.data?.messages ? { ...ctx.checkpoint.data } : null;
  let messages;
  let toolLog;
  if (!state) {
    await rm(dir, { recursive: true, force: true });
    for (const [file, content] of Object.entries(FIXTURE)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    }
    await runCommand("git", ["init", "-q"], { cwd: dir });
    messages = [
      { role: "system", content: "You are a coding agent working in a small Node.js repository. Use the tools: inspect the files, fix the bug so the test passes, run the tests, then call finish." },
      { role: "user", content: "The test in test/slug.test.js fails. Find the cause, change the code, run the tests and finish." }
    ];
    toolLog = [];
  } else {
    ({ messages, toolLog } = state);
  }
  const st = state || { messages, toolLog, turn: 0, requests: {} };
  let finished = null;
  for (let turn = st.turn; turn < 10 && !finished; turn += 1) {
    st.turn = turn;
    const request = await infer(ctx, st, "turn-" + turn, () => ({ slot: "coding", purpose: "model-coding-test", messages: st.messages, tools: CODING_TOOLS, maxTokens: 2048 }));
    const assistant = { role: "assistant", content: request.result.content || "", tool_calls: (request.result.toolCalls || []).map(call => ({ function: { name: call.name, arguments: call.arguments } })) };
    st.messages.push(assistant);
    if (!request.result.toolCalls?.length) break;
    for (const call of request.result.toolCalls) {
      let output;
      try {
        if (call.name === "list_files") output = (await listFixture(dir)).join("\n");
        else if (call.name === "read_file") output = await readFile(fixturePath(dir, call.arguments.path), "utf8");
        else if (call.name === "write_file") { await writeFile(fixturePath(dir, call.arguments.path), String(call.arguments.content ?? "")); output = "written"; }
        else if (call.name === "run_tests") { const run = await runCommand("npm", ["test"], { cwd: dir, timeoutMs: 120_000, signal: ctx.signal }); output = "exit " + run.code + "\n" + (run.stdout + run.stderr).slice(-3000); }
        else if (call.name === "finish") { finished = String(call.arguments.summary || ""); output = "ok"; }
        else output = "unknown tool " + call.name;
      } catch (error) {
        output = "error: " + error.message;
      }
      st.toolLog.push({ tool: call.name, args: call.name === "write_file" ? { path: call.arguments.path } : call.arguments });
      st.messages.push({ role: "tool", content: String(output).slice(0, 6000) });
    }
    st.turn = turn + 1;
    await ctx.checkpointWrite("coding-test-turn-" + turn, st);
  }
  // The verdict is the real test run, not the model's account of it.
  const verify = await runCommand("npm", ["test"], { cwd: dir, timeoutMs: 120_000, signal: ctx.signal });
  const diff = (await runCommand("git", ["diff", "--no-color"], { cwd: dir })).stdout;
  const usedTools = [...new Set(st.toolLog.map(item => item.tool))];
  const ok = verify.code === 0 && usedTools.includes("read_file") && usedTools.includes("write_file");
  const result = { ok, kind: "coding-test", slot: "coding", testsPassed: verify.code === 0, toolsUsed: usedTools, toolCalls: st.toolLog.length, finishSummary: finished, diff: diff.slice(0, 3000), testTail: (verify.stdout + verify.stderr).slice(-1500) };
  await recordModelTest(model, result);
  return { summary: model + " coding test " + (ok ? "PASSED" : "FAILED") + ": tests " + (verify.code === 0 ? "pass" : "fail") + ", tools " + usedTools.join(","), model, ...result };
}

const REVIEW_FIXTURE_DIFF = [
  "diff --git a/src/server.js b/src/server.js",
  "@@ -321,7 +321,6 @@",
  "     // Account administration: owner and admins only.",
  "     if (req.method === \"GET\" && p === \"/admin/users\") {",
  "-      assertOperator(req.headers, principal);",
  "       return json(res,200,await listUsers());",
  "     }"
].join("\n");
const REVIEW_FIXTURE_TESTS = "✖ http: members cannot reach the internal surface; the operator token and the owner can\n  AssertionError: expected 403, received 200\nℹ tests 12\nℹ pass 11\nℹ fail 1";

async function reasoningTest(ctx) {
  const config = await getModelConfig();
  const model = config.slots.reasoning.model;
  const state = ctx.checkpoint?.data ? { ...ctx.checkpoint.data } : { requests: {} };
  const request = await infer(ctx, state, "review", () => ({
    slot: "reasoning",
    purpose: "model-reasoning-test",
    format: "json",
    maxTokens: 2048,
    messages: [
      { role: "system", content: "You plan engineering work and review changes. Reply with one JSON object only." },
      { role: "user", content: "Task: 'speed up the admin users listing'. 1) Give a short plan. 2) Review this proposed diff and its real test output, and decide.\n\nDiff:\n" + REVIEW_FIXTURE_DIFF + "\n\nTest output:\n" + REVIEW_FIXTURE_TESTS +
        "\n\nReturn {\"plan\":[string],\"verdict\":\"approve\"|\"revise\"|\"reject\",\"issues\":[string]}." }
    ]
  }));
  let parsed = null;
  let parseError = null;
  try { parsed = extractJsonObject(request.result.content, { what: "review" }); } catch (error) { parseError = error.message; }
  const issues = JSON.stringify(parsed?.issues || []).toLowerCase();
  const caughtSafety = /auth|admin|permission|operator|access|privilege/.test(issues);
  const caughtTest = /test|fail|403|200/.test(issues);
  const ok = Boolean(parsed) && parsed.verdict !== "approve" && caughtSafety && caughtTest && Array.isArray(parsed.plan) && parsed.plan.length > 0;
  const result = { ok, kind: "reasoning-test", slot: "reasoning", verdict: parsed?.verdict || null, caughtSafetyFailure: caughtSafety, caughtTestFailure: caughtTest, planSteps: parsed?.plan?.length || 0, parseError, usage: request.usage };
  await recordModelTest(model, result);
  return { summary: model + " reasoning test " + (ok ? "PASSED" : "FAILED") + ": verdict " + result.verdict + ", safety " + caughtSafety + ", test " + caughtTest, model, ...result, issues: parsed?.issues || [] };
}

export function builderHandlers(options = {}) {
  return {
    async run(ctx) {
      const cfg = repoConfig(ctx.env);
      ctx.inferenceWaitMs = cfg.inferenceWaitMs;
      await mkdir(ctx.workspace, { recursive: true });
      switch (ctx.task.kind) {
        case "repo.inspect": return repoInspect(ctx, cfg);
        case "code.change": return codeChange(ctx, cfg);
        case "model.coding_test": return codingTest(ctx);
        case "model.reasoning_test": return reasoningTest(ctx);
        default: throw new NonRetryableError("System A does not handle task kind " + ctx.task.kind);
      }
    }
  };
}

export const BUILDER_TASK_KINDS = Object.freeze(["repo.inspect", "code.change", "model.coding_test", "model.reasoning_test"]);
export { getInference };
