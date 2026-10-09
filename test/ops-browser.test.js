import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-browser-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_STORE = "json";

const { runBrowserCheck, DEFAULT_BROWSER_POLICY } = await import("../src/ops-browser.js");
const { listEvents } = await import("../src/ops-state.js");

// A real headless Chrome, driven over a pipe. Skipped only where no Chrome or
// Chromium is installed; the policy tests below run everywhere.
const candidates = [process.env.RAZEKIT_BROWSER_EXECUTABLE, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
const executable = candidates.find(item => existsSync(item));
const env = { ...process.env, RAZEKIT_BROWSER_EXECUTABLE: executable || "" };

test.after(() => rm(dataDir, { recursive: true, force: true }));

test("the policy refuses the instance metadata service and private addresses before a browser starts", async () => {
  await assert.rejects(() => runBrowserCheck({ url: "http://169.254.169.254/latest/meta-data/", policy: { ...DEFAULT_BROWSER_POLICY, allowedHosts: ["169.254.169.254"] }, env }), /Private or local network/);
  await assert.rejects(() => runBrowserCheck({ url: "http://10.0.0.5/", policy: { ...DEFAULT_BROWSER_POLICY, allowedHosts: ["10.0.0.5"] }, env }), /Private or local network/);
  await assert.rejects(() => runBrowserCheck({ url: "https://not-allowed.example/", env }), /not allowed by policy/);
  await assert.rejects(() => runBrowserCheck({ url: "file:///etc/passwd", env }), /only permits HTTP/);
});

test("a real browser loads an allowed page, runs checks, and blocks disallowed subresources", { skip: !executable && "no Chrome/Chromium on this host" }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Niomi smoke</title><h1 id=hello>Hello from the app</h1>" +
      "<img src='http://169.254.169.254/latest/meta-data/iam'><script src='https://tracker.example/x.js'></script>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port + "/";
  try {
    const evidence = await runBrowserCheck({
      url,
      policy: { defaultAction: "deny", allowedHosts: ["127.0.0.1"], allowedPorts: [server.address().port], denyPrivateNetworks: false },
      checks: [{ type: "title-includes", value: "Niomi smoke" }, { type: "text-includes", value: "Hello from the app" }, { type: "selector-visible", value: "#hello" }],
      artifactDir: path.join(dataDir, "shots"),
      taskId: "task_browser_test",
      resolve: false,
      env
    });
    assert.equal(evidence.status, 200);
    assert.equal(evidence.ok, true);
    assert.ok(evidence.checks.every(check => check.passed));
    const blockedUrls = evidence.blockedRequests.map(item => item.url);
    assert.ok(blockedUrls.some(item => item.startsWith("http://169.254.169.254")), "metadata service request blocked");
    assert.ok(blockedUrls.some(item => item.startsWith("https://tracker.example")), "unlisted host blocked");
    assert.match(evidence.screenshot.sha256, /^[0-9a-f]{64}$/);
    const events = await listEvents({ source: "niomi", taskId: "task_browser_test" });
    assert.equal(events[0].action, "browser.check");
    assert.equal(events[0].result, "pass");
  } finally {
    server.close();
  }
});
