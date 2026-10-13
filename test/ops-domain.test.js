import test from "node:test";
import assert from "node:assert/strict";
import {
  builderPathAllowed,
  deriveProcessStatus,
  redactText,
  redactValue,
  validateModelId,
  DEFAULT_MODEL_ASSIGNMENTS
} from "../src/ops-domain.js";

const thresholds = { intervalMs: 15_000, staleAfterMs: 45_000, offlineAfterMs: 120_000 };
const now = Date.parse("2026-10-09T12:00:00Z");
const at = ms => new Date(now - ms).toISOString();

test("a process with no heartbeat is not configured, never offline or running", () => {
  assert.equal(deriveProcessStatus(null, { now, thresholds }).status, "not_configured");
  assert.equal(deriveProcessStatus({}, { now, thresholds }).status, "not_configured");
});

test("only a fresh heartbeat reports the process's own status", () => {
  assert.equal(deriveProcessStatus({ at: at(5_000), status: "running" }, { now, thresholds }).status, "running");
  assert.equal(deriveProcessStatus({ at: at(5_000), status: "paused" }, { now, thresholds }).status, "paused");
  assert.equal(deriveProcessStatus({ at: at(5_000), status: "starting" }, { now, thresholds }).status, "starting");
  assert.equal(deriveProcessStatus({ at: at(5_000), status: "stopping" }, { now, thresholds }).status, "stopping");
  assert.equal(deriveProcessStatus({ at: at(5_000), status: "failed" }, { now, thresholds }).status, "failed");
});

test("an old 'running' heartbeat ages into stale, then offline", () => {
  const stale = deriveProcessStatus({ at: at(60_000), status: "running" }, { now, thresholds });
  assert.equal(stale.status, "stale");
  assert.equal(stale.ageMs, 60_000);
  assert.equal(deriveProcessStatus({ at: at(10 * 60_000), status: "running" }, { now, thresholds }).status, "offline");
});

test("a clean shutdown is offline immediately, whatever its age", () => {
  assert.equal(deriveProcessStatus({ at: at(1_000), status: "stopped" }, { now, thresholds }).status, "offline");
});

test("an unknown reported status is treated as failed, not as running", () => {
  assert.equal(deriveProcessStatus({ at: at(1_000), status: "totally-fine" }, { now, thresholds }).status, "failed");
});

test("System A paths: inside the scope area only, never on the deny list", () => {
  assert.equal(builderPathAllowed("src/game-executor.js", "konami"), true);
  assert.equal(builderPathAllowed("src/game-executor.js", "niomi"), false, "another area's file");
  assert.equal(builderPathAllowed("test/anything.test.js", "dev-backend"), true);
  assert.equal(builderPathAllowed("src/auth.js", "dev-backend"), false, "identity is denied");
  assert.equal(builderPathAllowed("src/store.js", "dev-backend"), false);
  assert.equal(builderPathAllowed(".github/workflows/ci.yml", "dev-workflows"), false);
  assert.equal(builderPathAllowed("src/../src/auth.js", "dev-backend"), false);
  assert.equal(builderPathAllowed("/etc/passwd", "dev-backend"), false);
  assert.equal(builderPathAllowed("C:/x.js", "dev-backend"), false);
  assert.equal(builderPathAllowed("src/game-executor.js", "not-an-area"), false);
});

test("model IDs: the approved defaults, supported list only, never a cloud variant", () => {
  assert.deepEqual(DEFAULT_MODEL_ASSIGNMENTS, { coding: "qwen3-coder:30b", reasoning: "gpt-oss:20b" });
  assert.equal(validateModelId("qwen3-coder:30b", {}), "qwen3-coder:30b");
  assert.equal(validateModelId("gpt-oss:20b", {}), "gpt-oss:20b");
  assert.equal(validateModelId("devstral-small-2:24b", {}), "devstral-small-2:24b");
  assert.throws(() => validateModelId("llama3:8b", {}), /not in the supported list/);
  assert.throws(() => validateModelId("gpt-oss:120b-cloud", { RAZEKIT_SUPPORTED_MODELS: "gpt-oss:120b-cloud" }), /Cloud/);
  assert.throws(() => validateModelId("qwen3-coder:30b; rm -rf /", {}), /valid/);
});

test("redaction removes secrets from text and keys, but keeps token counts", () => {
  const text = redactText("db postgres://user:hunter2@host/db token ghp_" + "a".repeat(36) + " key gsk_" + "b".repeat(30) + " password=swordfish AKIA" + "C".repeat(16));
  assert.doesNotMatch(text, /hunter2|ghp_a|gsk_b|swordfish|AKIAC/);
  const value = redactValue({ apiKey: "x", accessToken: "y", nested: { databaseUrl: "z" }, usage: { promptTokens: 12, completionTokens: 34 }, contextTokens: 16384 });
  assert.equal(value.apiKey, "[redacted]");
  assert.equal(value.accessToken, "[redacted]");
  assert.equal(value.nested.databaseUrl, "[redacted]");
  assert.deepEqual(value.usage, { promptTokens: 12, completionTokens: 34 });
  assert.equal(value.contextTokens, 16384);
});
