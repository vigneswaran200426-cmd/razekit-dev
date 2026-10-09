import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNetworkAccess, assertResolvedNetworkAccess } from "./network-policy.js";
import { logEvent } from "./ops-state.js";

// Real, permission-controlled browser access for the agents.
//
// A headless Chromium (playwright-core; on the control plane it runs inside
// the restricted browser container) where every request — the page and each
// subresource — is checked against a network policy before it leaves: hosts
// must be allowed, private and link-local addresses (including the instance
// metadata service, 169.254.169.254) are refused after DNS resolution, and
// only allowed ports pass. Every session is written to the activity log:
// what was opened, what was blocked, what was seen.
//
// No remote-debugging port is opened: Playwright drives the browser over a
// pipe, so there is nothing to expose.

// The network policy treats an empty allowlist as "any host", so the browser
// never runs with one: documentation, GitHub, package registries and the DEV
// deployment by default, replaceable with RAZEKIT_BROWSER_ALLOWED_HOSTS.
export const DEFAULT_BROWSER_HOSTS = Object.freeze([
  "github.com", "githubusercontent.com", "npmjs.com", "npmjs.org", "nodejs.org", "developer.mozilla.org",
  "pypi.org", "python.org", "ollama.com", "docs.godotengine.org", "razekit-dev.onrender.com"
]);

export function browserPolicy(env = process.env) {
  const hosts = String(env.RAZEKIT_BROWSER_ALLOWED_HOSTS || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  return { defaultAction: "deny", allowedHosts: hosts.length ? hosts : [...DEFAULT_BROWSER_HOSTS], allowedPorts: [80, 443], denyPrivateNetworks: true };
}

export const DEFAULT_BROWSER_POLICY = Object.freeze(browserPolicy({}));

async function launch(env) {
  let playwright;
  try {
    playwright = await import("playwright-core");
  } catch {
    throw new Error("playwright-core is not installed on this host");
  }
  const options = { headless: true, args: ["--no-first-run", "--disable-dev-shm-usage", "--disable-extensions"] };
  if (env.RAZEKIT_BROWSER_EXECUTABLE) options.executablePath = env.RAZEKIT_BROWSER_EXECUTABLE;
  else options.channel = env.RAZEKIT_BROWSER_CHANNEL || "chromium";
  return playwright.chromium.launch(options);
}

/**
 * Opens a URL under a policy and runs simple, declarative checks.
 * Returns evidence; never claims a check passed that it did not run.
 */
export async function runBrowserCheck({
  url,
  policy = null,
  checks = [],
  requester = "niomi",
  taskId = null,
  artifactDir = null,
  timeoutMs = 30_000,
  env = process.env,
  resolve = true
}) {
  policy = policy || browserPolicy(env);
  if (!policy.allowedHosts?.length) throw new Error("A browser policy must list its allowed hosts");
  assertNetworkAccess(policy, url);
  if (resolve && policy.denyPrivateNetworks !== false) await assertResolvedNetworkAccess(policy, url);
  const blocked = [];
  const consoleErrors = [];
  const started = Date.now();
  const browser = await launch(env);
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", async route => {
      const target = route.request().url();
      if (target.startsWith("data:") || target.startsWith("blob:")) return route.continue();
      try {
        assertNetworkAccess(policy, target);
        if (resolve && policy.denyPrivateNetworks !== false) await assertResolvedNetworkAccess(policy, target);
        return route.continue();
      } catch (error) {
        blocked.push({ url: target.slice(0, 300), reason: error.message });
        return route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
    const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    const results = [];
    for (const check of checks) {
      if (check.type === "title-includes") {
        const title = await page.title();
        results.push({ ...check, passed: title.includes(check.value), observed: title });
      } else if (check.type === "text-includes") {
        const text = await page.locator("body").innerText({ timeout: 5000 });
        results.push({ ...check, passed: text.includes(check.value), observed: text.slice(0, 200) });
      } else if (check.type === "selector-visible") {
        const visible = await page.locator(check.value).first().isVisible().catch(() => false);
        results.push({ ...check, passed: visible });
      } else {
        results.push({ ...check, passed: false, observed: "unsupported check type" });
      }
    }
    let screenshot = null;
    if (artifactDir) {
      const png = await page.screenshot({ fullPage: false });
      await mkdir(artifactDir, { recursive: true });
      const file = path.join(artifactDir, "browser-" + Date.now() + ".png");
      await writeFile(file, png);
      screenshot = { path: file, sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length };
    }
    const evidence = {
      url,
      finalUrl: page.url(),
      status: response?.status() ?? null,
      title: await page.title(),
      checks: results,
      ok: Boolean(response?.ok()) && results.every(item => item.passed),
      blockedRequests: blocked,
      consoleErrors,
      screenshot,
      durationMs: Date.now() - started
    };
    await logEvent({ source: requester, severity: evidence.ok ? "info" : "warn", taskId, action: "browser.check", result: evidence.ok ? "pass" : "fail", message: url + " -> HTTP " + evidence.status + ", " + results.filter(item => item.passed).length + "/" + results.length + " checks, " + blocked.length + " blocked", data: { blocked: blocked.slice(0, 20), finalUrl: evidence.finalUrl } }).catch(() => {});
    return evidence;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Niomi's browser smoke-test adapter, in the shape app-web-executor expects. */
export class PlaywrightBrowserAdapter {
  constructor({ policy = null, env = process.env } = {}) {
    this.policy = policy || browserPolicy(env);
    this.env = env;
  }

  async execute(step) {
    const checks = (step.checks || []).map(check => (typeof check === "string" ? { type: "text-includes", value: check } : check));
    const evidence = await runBrowserCheck({
      url: step.url,
      policy: step.policy || this.policy,
      checks,
      requester: "niomi",
      taskId: step.context?.taskId || null,
      artifactDir: step.workspaceRoot ? path.join(step.workspaceRoot, ".razekit", "browser") : null,
      env: this.env
    });
    if (!evidence.ok) throw new Error("Browser smoke test failed: HTTP " + evidence.status + ", checks " + JSON.stringify(evidence.checks.map(item => [item.value, item.passed])));
    return { ok: true, url: evidence.finalUrl, checks: evidence.checks, screenshot: evidence.screenshot, blockedRequests: evidence.blockedRequests };
  }
}
