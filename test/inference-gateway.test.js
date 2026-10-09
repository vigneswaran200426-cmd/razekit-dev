import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "razekit-gateway-"));
process.env.RAZEKIT_DATA_DIR = dataDir;
process.env.RAZEKIT_STORE = "json";

const { InferenceGateway, enqueueModelTest, gpuCostSoFar, gatewayConfig } = await import("../src/inference-gateway.js");
const { OllamaClient } = await import("../src/ollama-client.js");
const { signRequest } = await import("../src/gpu-controller.js");
const state = await import("../src/ops-state.js");
const { loadDb } = await import("../src/store.js");

// A stand-in that speaks the Ollama HTTP API. It is a test double for the
// gateway's queueing and accounting logic — it says nothing about whether the
// real approved models run, which only a real GPU can show.
function fakeOllama({ installed = ["qwen3-coder:30b", "gpt-oss:20b"], respond }) {
  const calls = [];
  let loaded = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, body });
    const send = data => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/version") return send({ version: "0.12.0-test" });
    if (req.url === "/api/tags") return send({ models: installed.map(name => ({ name, size: 19e9, digest: "sha256:" + name, details: { quantization_level: "Q4_K_M", parameter_size: "30B" } })) });
    if (req.url === "/api/ps") return send({ models: loaded.map(name => ({ name, size: 20e9, size_vram: 19e9 })) });
    if (req.url === "/api/generate" && body.keep_alive === 0) { loaded = loaded.filter(name => name !== body.model); return send({ done: true }); }
    if (req.url === "/api/chat") {
      if (loaded.length && !loaded.includes(body.model)) { res.writeHead(500); return res.end(JSON.stringify({ error: "two models loaded at once" })); }
      loaded = [body.model];
      return send({ model: body.model, message: respond(body), done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 30, total_duration: 2.5e9, load_duration: 1e9 });
    }
    res.writeHead(404); res.end("{}");
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: "http://127.0.0.1:" + server.address().port, get loaded() { return loaded; } })));
}

const noGpu = { configured: false };

test.after(() => rm(dataDir, { recursive: true, force: true }));

test("with the model server unreachable, requests wait in the queue and nothing is invented", async () => {
  const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: "http://127.0.0.1:9" }), gpu: noGpu, env: {} });
  const request = await state.enqueueInference({ requester: "builder", slot: "coding", purpose: "t", messages: [{ role: "user", content: "hi" }] });
  await gateway.tick();
  const after = await state.getInference(request.id);
  assert.equal(after.status, "queued");
  assert.equal(after.result, null);
  const beats = await state.getHeartbeats();
  assert.equal(beats.gateway.ollamaReachable, false);
  assert.match(beats.gateway.statusReason, /queued; inference is unavailable/);
  await state.finishInference(request.id, { ok: false, model: null, error: "test cleanup" });
});

test("dispatch evicts the other model first, so only one is ever loaded, and usage is attributed", async () => {
  const fake = await fakeOllama({ respond: body => ({ role: "assistant", content: "answer from " + body.model }) });
  try {
    const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: fake.url }), gpu: noGpu, env: {} });
    const coding = await state.enqueueInference({ requester: "builder", slot: "coding", purpose: "t", messages: [{ role: "user", content: "code" }] });
    const reasoning = await state.enqueueInference({ requester: "auditor", slot: "reasoning", purpose: "t", messages: [{ role: "user", content: "think" }] });
    await gateway.tick();
    await gateway.tick();
    const a = await state.getInference(coding.id);
    const b = await state.getInference(reasoning.id);
    assert.equal(a.status, "completed");
    assert.equal(a.model, "qwen3-coder:30b");
    assert.equal(a.result.content, "answer from qwen3-coder:30b");
    assert.equal(b.model, "gpt-oss:20b");
    assert.deepEqual(fake.loaded, ["gpt-oss:20b"]);
    assert.ok(fake.calls.some(call => call.path === "/api/generate" && call.body.model === "qwen3-coder:30b" && call.body.keep_alive === 0), "the coding model was unloaded before the reasoning model ran");
    const chat = fake.calls.find(call => call.path === "/api/chat");
    assert.equal(chat.body.options.num_ctx, 16384, "16K context by default");
    const db = await loadDb();
    const builderUsage = db.opsModelUsage.find(row => row.requester === "builder" && row.slot === "coding");
    assert.equal(builderUsage.promptTokens, 120);
    assert.equal(builderUsage.completionTokens, 30);
    assert.ok(db.opsModelUsage.find(row => row.requester === "auditor" && row.slot === "reasoning"));
    const status = await state.getModelStatus();
    assert.equal(status.reachable, true);
    assert.equal(status.models["qwen3-coder:30b"].installed, true);
  } finally {
    fake.server.close();
  }
});

test("a model test passes only when the model itself calls the test tool", async () => {
  const good = await fakeOllama({ respond: () => ({ role: "assistant", content: "", tool_calls: [{ function: { name: "report_status", arguments: { ok: true, note: "I am here" } } }] }) });
  try {
    const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: good.url }), gpu: noGpu, env: {} });
    const request = await enqueueModelTest("reasoning", "owner@example.com");
    await gateway.tick();
    const status = await state.getModelStatus();
    const model = status.models["gpt-oss:20b"];
    assert.equal(model.lastTest.ok, true);
    assert.equal(model.lastTest.toolCalling, true);
    assert.ok(model.lastSuccessfulTestAt);
    assert.equal((await state.getInference(request.id)).status, "completed");
  } finally { good.server.close(); }

  const bad = await fakeOllama({ respond: () => ({ role: "assistant", content: "Sure! Status is OK." }) });
  try {
    const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: bad.url }), gpu: noGpu, env: {} });
    await enqueueModelTest("coding", "owner@example.com");
    await gateway.tick();
    const model = (await state.getModelStatus()).models["qwen3-coder:30b"];
    assert.equal(model.lastTest.ok, false, "prose claiming success is not a passed tool call");
    assert.equal(model.lastSuccessfulTestAt ?? null, null);
  } finally { bad.server.close(); }
});

test("a requester over its daily token budget is refused with the reason", async () => {
  const fake = await fakeOllama({ respond: () => ({ role: "assistant", content: "x" }) });
  try {
    const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: fake.url }), gpu: noGpu, env: { RAZEKIT_TOKENS_PER_DAY_KONAMI: "100" } });
    const first = await state.enqueueInference({ requester: "konami", slot: "coding", purpose: "t", messages: [{ role: "user", content: "a" }] });
    await gateway.tick();
    assert.equal((await state.getInference(first.id)).status, "completed");
    const second = await state.enqueueInference({ requester: "konami", slot: "coding", purpose: "t", messages: [{ role: "user", content: "b" }] });
    await gateway.tick();
    const refused = await state.getInference(second.id);
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /Daily token budget for konami/);
  } finally { fake.server.close(); }
});

test("emergency stop: the gateway dispatches nothing", async () => {
  const fake = await fakeOllama({ respond: () => ({ role: "assistant", content: "x" }) });
  try {
    await state.setSetting("emergency-stop", { engaged: true, by: "owner", at: new Date().toISOString() }, "owner");
    const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: fake.url }), gpu: noGpu, env: {} });
    const request = await state.enqueueInference({ requester: "niomi", slot: "coding", purpose: "t", messages: [{ role: "user", content: "a" }] });
    const result = await gateway.tick();
    assert.equal(result.status, "paused");
    assert.equal((await state.getInference(request.id)).status, "queued");
    await state.setSetting("emergency-stop", { engaged: false }, "owner");
    await gateway.tick();
    assert.equal((await state.getInference(request.id)).status, "completed");
  } finally { fake.server.close(); }
});

function fakeGpu(initial = "stopped") {
  const calls = [];
  let current = initial;
  return {
    configured: true,
    calls,
    set state(value) { current = value; },
    async describe() { calls.push("describe"); return { configured: true, instanceId: "i-test", state: current, source: "test" }; },
    async start() { calls.push("start"); current = "pending"; return { requested: "start", currentState: "pending" }; },
    async stop() { calls.push("stop"); current = "stopping"; return { requested: "stop", currentState: "stopping" }; }
  };
}

test("the GPU is never started without an hourly rate and a hard monthly budget", async () => {
  const gpu = fakeGpu("stopped");
  const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: "http://127.0.0.1:9" }), gpu, env: { RAZEKIT_GPU_AUTO_START: "true" } });
  const request = await state.enqueueInference({ requester: "builder", slot: "coding", purpose: "t", messages: [{ role: "user", content: "a" }] });
  await gateway.tick();
  assert.ok(!gpu.calls.includes("start"));
  assert.match((await state.getHeartbeats()).gateway.statusReason, /not configured; refusing/);
  await state.finishInference(request.id, { ok: false, model: null, error: "cleanup" });
});

test("with a budget, queued work starts the GPU; idle time stops it; an exhausted budget stops it", async () => {
  const env = { RAZEKIT_GPU_AUTO_START: "true", RAZEKIT_GPU_HOURLY_USD: "0.80", RAZEKIT_GPU_MONTHLY_BUDGET_USD: "40", RAZEKIT_GPU_IDLE_STOP_MINUTES: "1" };
  const gpu = fakeGpu("stopped");
  const gateway = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: "http://127.0.0.1:9" }), gpu, env });
  const request = await state.enqueueInference({ requester: "builder", slot: "coding", purpose: "t", messages: [{ role: "user", content: "a" }] });
  await gateway.tick();
  assert.ok(gpu.calls.includes("start"), "queued work with budget remaining starts the GPU");
  await state.finishInference(request.id, { ok: false, model: null, error: "cleanup" });

  gpu.state = "running";
  gateway.lastGpuCheckAt = 0;
  gateway.lastActivityAt = Date.now() - 5 * 60_000;
  await gateway.tick();
  assert.ok(gpu.calls.includes("stop"), "idle beyond the limit stops the GPU");

  // Measured running time past the budget forces a stop.
  const month = new Date().toISOString().slice(0, 7);
  await state.updateGpuState({ state: "running", runningMsByMonth: { [month]: 60 * 3_600_000 } });
  const cost = gpuCostSoFar(await state.getGpuState(), gatewayConfig(env));
  assert.equal(cost.estimatedUsd, 48);
  assert.equal(cost.remainingUsd, 0);
  const gpu2 = fakeGpu("running");
  const gateway2 = new InferenceGateway({ ollama: new OllamaClient({ baseUrl: "http://127.0.0.1:9" }), gpu: gpu2, env });
  gateway2.lastGpuCheckAt = Date.now();
  gateway2.lastActivityAt = Date.now();
  await gateway2.tick();
  assert.ok(gpu2.calls.includes("stop"), "hard budget limit stops a running GPU");
});

test("SigV4 signing produces a well-formed authorization header and carries the session token", () => {
  const headers = signRequest({
    method: "POST", host: "ec2.us-east-2.amazonaws.com", body: "Action=DescribeInstances&Version=2016-11-15", service: "ec2", region: "us-east-2",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session" },
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, now: new Date("2026-10-09T00:00:00Z")
  });
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261009\/us-east-2\/ec2\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(headers["x-amz-date"], "20261009T000000Z");
  assert.equal(headers["x-amz-security-token"], "session");
});

test("SigV4 matches AWS's published get-vanilla test vector", () => {
  const headers = signRequest({
    method: "GET", host: "example.amazonaws.com", path: "/", body: "", service: "service", region: "us-east-1",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    now: new Date("2015-08-30T12:36:00Z")
  });
  assert.ok(headers.authorization.endsWith("Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"));
});

test("Niomi/Konami adapter: attributed to the agent, retryable while queued, shaped when answered", async () => {
  const { OllamaGatewayAdapter } = await import("../src/adapters/ollama-gateway-adapter.js");
  const adapter = new OllamaGatewayAdapter({ slot: "coding", waitMs: 200, pollMs: 50 });
  const request = { role: "implementer", context: { agent: { id: "konami_1", type: "konami" }, task: { id: "task_k", title: "Game", type: "game" } } };
  await assert.rejects(() => adapter.generate(request), error => error.retryable === true && error.code === "GATEWAY_QUEUED");
  const db = await loadDb();
  const queued = db.opsInferenceRequests.filter(item => item.purpose === "konami:implementer" && item.status === "queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].slot, "coding");
  await state.finishInference(queued[0].id, { ok: true, model: "qwen3-coder:30b", result: { content: JSON.stringify({ summary: "Built the level", filesChanged: 2 }) }, usage: { promptTokens: 50, completionTokens: 20 } });
  const answer = await adapter.generate(request);
  assert.equal(answer.implementation.summary, "Built the level");
  assert.equal(answer.usage.inputTokens, 50);
  assert.equal((await loadDb()).opsInferenceRequests.filter(item => item.purpose === "konami:implementer").length, 1, "the retry reused the queued request instead of asking twice");
});
