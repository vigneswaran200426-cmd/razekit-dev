// The execution runtime and verification, run for real.
//
// These tests write real files, run real processes under Node's permission
// model, build, package and verify. They also attack the runtime the way a
// hostile or confused plan would: reading outside the workspace, reading the
// worker's environment, spawning a process, looping forever, printing without
// end, tampering with an artifact, planting a link, leaking a secret.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalRuntime, SandboxRuntime, ARTIFACT_PATH } from '../src/development/runtime/executor.js';
import { tarGz, listTarGz } from '../src/development/runtime/packager.js';
import { sha256 } from '../src/development/runtime/workspace.js';
import { checkGameManifest } from '../src/development/runtime/engineCheck.js';
import { verifyBuild } from '../src/development/verification.js';
import { deterministicAstra, deterministicFable } from '../src/development/engine/deterministic.js';
import { validateArchitecturePlan, validateExecutionPlan } from '../src/development/engine/schemas.js';
import { agentForTaskType, AGENTS } from '../src/development/engine/agents.js';
import { newWorkspaceId } from '../src/development/engine/task.js';
import { GAME_RUNTIME_PATH } from '../src/development/engine/gameRuntime.js';
import type { AcceptanceCriterion, DevTask, ExecutionPlan, TaskType } from '../src/development/engine/types.js';
import { makeTask } from './helpers/dev.js';

let root: string;
let runtime: LocalRuntime;
const SECRET = 'sk-test-worker-secret-value-0123456789';

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rk-dev-runtime-'));
  runtime = new LocalRuntime({ root, secrets: [SECRET] });
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Plan → implement → execute with the deterministic pair, the way the orchestrator will. */
async function deterministicBuild(taskType: TaskType, request?: string) {
  const task = makeTask({ taskType, originalRequest: request, workspaceId: newWorkspaceId() });
  const agent = agentForTaskType(taskType);
  const availability = runtime.availability();
  const planRaw = await deterministicAstra().preparePlan({ task, agent, usableTools: [...agent.tools], unavailableTools: [] }).run();
  const plan = validateArchitecturePlan(planRaw.raw);
  const implRaw = await deterministicFable()
    .prepareImplement({ task, agent, plan, previous: null, lastResult: null, review: null, refinements: [], repairNotes: [], usableTools: [...agent.tools], providedFiles: runtime.providedFiles(agent) })
    .run();
  const execPlan = validateExecutionPlan(implRaw.raw, agent, availability, runtime.providedFiles(agent).map((f) => f.path));
  const result = await runtime.execute({ workspaceId: task.workspaceId, agent, plan: execPlan });
  const acceptance: AcceptanceCriterion[] = plan.acceptance.map((a, i) => ({ id: `plan-${i + 1}`, text: a.text, source: 'plan', check: a.check, status: 'pending' }));
  const built: DevTask = { ...task, acceptance, blackboard: { ...task.blackboard, lastResult: result } };
  return { task: built, agent, plan, execPlan, result };
}

for (const taskType of ['website', 'app', 'game'] as const) {
  test(`a ${taskType} is written, tested, built, packaged and verified for real`, async () => {
    const { task, agent, execPlan, result } = await deterministicBuild(
      taskType,
      taskType === 'website' ? 'A landing page with features, pricing and a contact form.' : undefined
    );
    for (const s of result.steps) assert.equal(s.status, 'passed', `${s.id}: ${s.error ?? ''}\n${s.output}`);
    assert.equal(result.ok, true);
    assert.ok(result.artifact && result.artifact.bytes > 0);

    const entries = listTarGz((await runtime.workspaces.readBytes(task.workspaceId, ARTIFACT_PATH))!);
    assert.ok(entries.some((e) => e.path === 'index.html'), 'the artifact contains the entry page');
    if (taskType === 'game') assert.ok(entries.some((e) => e.path === GAME_RUNTIME_PATH), 'the game ships its runtime');

    const outcome = await verifyBuild({ runtime, task, agent, plan: execPlan, secrets: [SECRET] });
    assert.equal(outcome.report.status, 'passed', JSON.stringify(outcome.report.failures, null, 2));
    assert.ok(outcome.acceptance.length > 0 && outcome.acceptance.every((c) => c.status === 'passed'));
  });
}

test('the deterministic builder honours the sections the request asks for', async () => {
  const { task } = await deterministicBuild('website', 'A portfolio site with a gallery, testimonials and a contact form.');
  const html = (await runtime.workspaces.readText(task.workspaceId, 'dist/index.html'))!;
  for (const id of ['hero', 'gallery', 'testimonials', 'contact', 'cta']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<form/);
});

// ── Containment ───────────────────────────────────────────────────────────────

function hostilePlan(files: Record<string, string>, steps: ExecutionPlan['steps']): ExecutionPlan {
  return { files: Object.entries(files).map(([p, content]) => ({ path: p, content })), steps, output: { dir: 'dist', entry: 'index.html' } };
}

test('a build cannot read outside its workspace, read the environment, or spawn processes', async () => {
  process.env.RK_DEV_TEST_SECRET = SECRET;
  const neighbour = newWorkspaceId();
  await runtime.workspaces.replaceSource(neighbour, [{ path: 'private.txt', content: 'neighbour data' }]);

  const wsId = newWorkspaceId();
  const plan = hostilePlan(
    {
      'tests/escape.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
test('the worker environment is not inherited', () => {
  assert.equal(process.env.RK_DEV_TEST_SECRET, undefined);
  assert.equal(process.env.DATABASE_URL, undefined);
});
test('another build is unreadable', () => {
  assert.throws(() => readFileSync('../${neighbour}/private.txt'), { code: 'ERR_ACCESS_DENIED' });
});
test('system files are unreadable', () => {
  assert.throws(() => readFileSync('/etc/passwd'), { code: 'ERR_ACCESS_DENIED' });
});
test('processes cannot be spawned', () => {
  assert.throws(() => execSync('id'), { code: 'ERR_ACCESS_DENIED' });
});
`,
    },
    [{ id: 'test', tool: 'test', args: ['tests/escape.test.mjs'] }]
  );
  const result = await runtime.execute({ workspaceId: wsId, agent: AGENTS.niomi, plan });
  delete process.env.RK_DEV_TEST_SECRET;
  assert.equal(result.steps[0].status, 'passed', result.steps[0].output);
});

test('a build that runs forever is killed at its timeout', async () => {
  const plan = hostilePlan({ 'spin.mjs': 'for (;;) {}' }, [{ id: 'spin', tool: 'node', args: ['spin.mjs'], timeoutMs: 1_000 }]);
  const started = Date.now();
  const result = await runtime.execute({ workspaceId: newWorkspaceId(), agent: AGENTS.niomi, plan });
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].error, 'Timed out.');
  assert.ok(Date.now() - started < 10_000);
});

test('runaway output is capped, and secrets in output are redacted', async () => {
  const plan = hostilePlan(
    { 'loud.mjs': `console.log('${SECRET}'); for (let i = 0; i < 200000; i++) console.log('x'.repeat(100));` },
    [{ id: 'loud', tool: 'node', args: ['loud.mjs'] }]
  );
  const result = await runtime.execute({ workspaceId: newWorkspaceId(), agent: AGENTS.niomi, plan });
  assert.ok(result.steps[0].output.length < 20_000);
  assert.ok(!result.steps[0].output.includes(SECRET));
});

test('a failed step skips its dependants and nothing else', async () => {
  const plan = hostilePlan(
    { 'fail.mjs': 'process.exit(3)', 'ok.mjs': 'console.log("fine")' },
    [
      { id: 'a', tool: 'node', args: ['fail.mjs'] },
      { id: 'b', tool: 'node', args: ['ok.mjs'], dependsOn: ['a'] },
      { id: 'c', tool: 'node', args: ['ok.mjs'] },
    ]
  );
  const result = await runtime.execute({ workspaceId: newWorkspaceId(), agent: AGENTS.niomi, plan });
  assert.deepEqual(result.steps.map((s) => [s.id, s.status]), [['a', 'failed'], ['b', 'skipped'], ['c', 'passed']]);
  assert.equal(result.ok, false);
});

test('files from the previous attempt do not survive into the next', async () => {
  const wsId = newWorkspaceId();
  await runtime.workspaces.replaceSource(wsId, [{ path: 'old.mjs', content: 'x' }]);
  await runtime.workspaces.replaceSource(wsId, [{ path: 'new.mjs', content: 'y' }]);
  assert.equal(await runtime.workspaces.readText(wsId, 'old.mjs'), null);
  assert.equal(await runtime.workspaces.readText(wsId, 'new.mjs'), 'y');
});

test('the sandbox runtime says it is unavailable instead of running anything', async () => {
  const sandbox = new SandboxRuntime({ root });
  assert.equal(sandbox.status.available, false);
  assert.equal(sandbox.availability().test.available, false);
  await assert.rejects(sandbox.execute(), (e: any) => e.code === 'DEV_RUNTIME_UNAVAILABLE');
});

// ── Verification catches what execution does not ─────────────────────────────

test('verification fails a tampered artifact', async () => {
  const b = await deterministicBuild('website');
  await appendFile(path.join(runtime.workspaces.pathFor(b.task.workspaceId), ARTIFACT_PATH), 'x');
  const out = await verifyBuild({ runtime, task: b.task, agent: b.agent, plan: b.execPlan, secrets: [] });
  assert.equal(out.report.status, 'failed');
  assert.ok(out.report.failures.some((f) => f.check === 'artifact'));
});

test('verification re-runs the tests rather than trusting the last run', async () => {
  const b = await deterministicBuild('app');
  const store = path.join(runtime.workspaces.pathFor(b.task.workspaceId), 'store.mjs');
  await writeFile(store, (await readFile(store, 'utf8')).replace("if (!clean) return null;", ''));
  const out = await verifyBuild({ runtime, task: b.task, agent: b.agent, plan: b.execPlan, secrets: [] });
  assert.ok(out.report.failures.some((f) => f.check === 'tests'), JSON.stringify(out.report.failures));
});

test('verification fails a planted link, a leaked secret, and open reservations', async () => {
  const b = await deterministicBuild('website');
  const dir = runtime.workspaces.pathFor(b.task.workspaceId);
  await symlink('/etc/passwd', path.join(dir, 'dist', 'passwd'));
  await writeFile(path.join(dir, 'config.mjs'), `export const key = '${SECRET}';`);
  const out = await verifyBuild({ runtime, task: { ...b.task, reservedMinor: 10 }, agent: b.agent, plan: b.execPlan, secrets: [SECRET] });
  const failed = out.report.failures.map((f) => f.check);
  assert.ok(failed.includes('isolation'), failed.join());
  assert.ok(failed.includes('secrets'), failed.join());
  assert.ok(failed.includes('budget'), failed.join());
});

test('a criterion with no machine check passes only on the reviewer’s explicit word, labelled as such', async () => {
  const b = await deterministicBuild('website');
  const vague: AcceptanceCriterion = { id: 'user-1', text: 'It feels premium', source: 'user', check: null, status: 'pending' };
  const withReview = (met: boolean): DevTask => ({
    ...b.task,
    acceptance: [...b.task.acceptance, vague],
    blackboard: { ...b.task.blackboard, lastReview: { decision: 'pass', summary: '', issues: [], criteria: [{ id: 'user-1', met, note: 'Clean type and spacing.' }] } },
  });
  const yes = await verifyBuild({ runtime, task: withReview(true), agent: b.agent, plan: b.execPlan, secrets: [] });
  const judged = yes.acceptance.find((c) => c.id === 'user-1')!;
  assert.equal(judged.status, 'passed');
  assert.match(judged.evidence!, /Judged by review, not machine-checked/);
  const no = await verifyBuild({ runtime, task: withReview(false), agent: b.agent, plan: b.execPlan, secrets: [] });
  assert.equal(no.report.status, 'failed');
});

test('a missing element fails its acceptance check with the reason', async () => {
  const b = await deterministicBuild('website');
  const task: DevTask = {
    ...b.task,
    acceptance: [{ id: 'user-1', text: 'A pricing table', source: 'user', check: { type: 'html_has', path: 'dist/index.html', id: 'pricing' }, status: 'pending' }],
  };
  const out = await verifyBuild({ runtime, task, agent: b.agent, plan: b.execPlan, secrets: [] });
  const c = out.acceptance[0];
  assert.equal(c.status, 'failed');
  assert.match(c.evidence!, /no element with id "pricing"/);
});

// ── Packaging and the game runtime ────────────────────────────────────────────

test('packaging is deterministic and round-trips', () => {
  const entries = [{ path: 'b.txt', data: Buffer.from('bee') }, { path: 'a/x.js', data: Buffer.from('x'.repeat(1000)) }];
  const one = tarGz(entries);
  const two = tarGz([...entries].reverse());
  assert.equal(sha256(one), sha256(two));
  assert.deepEqual(listTarGz(one), [{ path: 'a/x.js', size: 1000 }, { path: 'b.txt', size: 3 }]);
});

test('a game with an edited runtime or the wrong runtime id is rejected', async () => {
  const b = await deterministicBuild('game');
  assert.equal((await checkGameManifest(runtime.workspaces, b.task.workspaceId, 'dist')).ok, true);
  const dir = runtime.workspaces.pathFor(b.task.workspaceId);
  await appendFile(path.join(dir, 'dist', GAME_RUNTIME_PATH), '\n// cheat');
  const manifestPath = path.join(dir, 'dist', 'game.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, runtime: 'some-other-engine@9' }));
  const check = await checkGameManifest(runtime.workspaces, b.task.workspaceId, 'dist');
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /modified/.test(p)));
  assert.ok(check.problems.some((p) => /must declare runtime/.test(p)));
});

test('a plan may not overwrite a file RazeKit provides', () => {
  const agent = AGENTS.konami;
  const raw = {
    files: [{ path: GAME_RUNTIME_PATH, content: 'export {}' }, { path: 'tests/a.test.mjs', content: '' }],
    steps: [{ id: 'test', tool: 'test', args: ['tests/a.test.mjs'], dependsOn: [] }, { id: 'package', tool: 'package', args: [], dependsOn: [] }],
    output: { dir: 'dist', entry: 'index.html' },
    notes: '',
  };
  assert.throws(() => validateExecutionPlan(raw, agent, runtime.availability(), [GAME_RUNTIME_PATH]), /provided by RazeKit/);
});
