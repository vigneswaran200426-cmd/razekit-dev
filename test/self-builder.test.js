import test from "node:test";
import assert from "node:assert/strict";
import { isSafeRepoPath, parseModelPatch, providerConfig } from "../scripts/razekit-autobuilder.mjs";

test("path policy allows only explicitly permitted files and blocks sensitive paths", () => {
  assert.equal(isSafeRepoPath("src/worker-agent.js", ["src/worker-agent.js"]), true);
  assert.equal(isSafeRepoPath("test/worker-agent.test.js", ["test/**"]), true);
  assert.equal(isSafeRepoPath("src/auth.js", ["src/**"]), false);
  assert.equal(isSafeRepoPath("scripts/razekit-autobuilder.mjs", ["scripts/**"]), false);
  assert.equal(isSafeRepoPath(".github/workflows/ci.yml", [".github/**"]), false);
  assert.equal(isSafeRepoPath("self-build/backlog.json", ["self-build/**"]), false);
  assert.equal(isSafeRepoPath("../outside.js", ["**"]), false);
  assert.equal(isSafeRepoPath("/tmp/outside.js", ["**"]), false);
  assert.equal(isSafeRepoPath("src/../auth.js", ["src/**"]), false);
  assert.equal(isSafeRepoPath("package.json", ["**"]), false);
});

test("model response parser requires a summary and non-empty patch", () => {
  const got = parseModelPatch(JSON.stringify({
    summary: "Add a contained worker fix",
    patch: "diff --git a/src/worker-agent.js b/src/worker-agent.js\n"
  }));
  assert.equal(got.summary, "Add a contained worker fix");
  assert.match(got.patch, /^diff --git/);
  assert.throws(() => parseModelPatch(JSON.stringify({ summary: "No patch", patch: "" })), /non-empty/);
  assert.throws(() => parseModelPatch("not json"), /JSON/);
});

test("provider: Groq when its key is set, GitHub Models only when chosen, never anything else", () => {
  assert.equal(providerConfig({ GROQ_API_KEY: "k", GITHUB_TOKEN: "t", RAZEKIT_AUTOBUILD_PROVIDER: "github-models" }).name, "groq");
  const gm = providerConfig({ GITHUB_TOKEN: "t", RAZEKIT_AUTOBUILD_PROVIDER: "github-models" });
  assert.equal(gm.name, "github-models");
  assert.equal(gm.url, "https://models.github.ai/inference/chat/completions");
  assert.deepEqual(gm.extra, {}, "no Groq-only parameters are sent to GitHub Models");
  assert.equal(providerConfig({ GITHUB_TOKEN: "t" }).name, "none", "GitHub Models is used only when the workflow selects it");
  assert.equal(providerConfig({ RAZEKIT_AUTOBUILD_PROVIDER: "github-models" }).name, "none", "no token, no provider");
  assert.equal(providerConfig({}).name, "none");
});
