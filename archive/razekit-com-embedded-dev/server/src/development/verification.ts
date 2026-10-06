// Verification: whether a build is actually done, from evidence.
//
// This is the only thing allowed to complete a build, and it trusts nothing it
// is told. The executor said the tests passed — so the tests are run again.
// The executor said it packaged an artifact — so the artifact is opened, its
// checksum compared and its contents listed. The reviewer said it looks right —
// and that opinion is recorded as the reviewer's, but every criterion that has
// a machine check is checked against the built files regardless.
//
// Checks, each with its evidence:
//   tests        the plan's test steps, re-run now
//   output       the declared entry exists in the declared output directory
//   artifact     exists, matches its recorded checksum, contains the entry
//   budget       spend within the ceiling, nothing left reserved
//   isolation    no links or special files, nothing outside the workspace
//   secrets      no live secret value appears in any file the build wrote
//   engine       (games) the manifest and runtime are valid
//   acceptance   every criterion: machine-checked where it can be, otherwise
//                the reviewer's explicit judgement, labelled as such
import type { AgentDefinition } from './engine/agents.js';
import type { AcceptanceCheck, AcceptanceCriterion, DevTask, ExecutionPlan, VerificationReport } from './engine/types.js';
import { checkGameManifest } from './runtime/engineCheck.js';
import { ARTIFACT_PATH, type ExecutionRuntime } from './runtime/executor.js';
import { listTarGz } from './runtime/packager.js';
import { sha256 } from './runtime/workspace.js';

export const MAX_WORKSPACE_BYTES = 50_000_000;

export interface VerificationOutcome {
  report: VerificationReport;
  acceptance: AcceptanceCriterion[];
}

type Check = { check: string; passed: boolean; evidence: string };

const stripTags = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** Evaluates one acceptance check against the workspace. Linear-time lookups only. */
export async function evaluateCheck(
  runtime: ExecutionRuntime,
  task: DevTask,
  check: AcceptanceCheck,
  facts: { testsPassed: boolean; artifactOk: boolean }
): Promise<{ passed: boolean; evidence: string }> {
  const ws = runtime.workspaces;
  switch (check.type) {
    case 'tests_pass':
      return { passed: facts.testsPassed, evidence: facts.testsPassed ? 'Tests re-run and passed.' : 'Tests did not pass on re-run.' };
    case 'artifact_packaged':
      return { passed: facts.artifactOk, evidence: facts.artifactOk ? 'Artifact present and checksum verified.' : 'No valid artifact.' };
    case 'file_exists': {
      const found = (await ws.readBytes(task.workspaceId, check.path)) !== null;
      return { passed: found, evidence: found ? `${check.path} exists.` : `${check.path} is missing.` };
    }
    case 'html_has': {
      const html = await ws.readText(task.workspaceId, check.path);
      if (html === null) return { passed: false, evidence: `${check.path} is missing.` };
      const lower = html.toLowerCase();
      const misses: string[] = [];
      if (check.tag && !new RegExp(`<${check.tag}[\\s>/]`, 'i').test(html)) misses.push(`no <${check.tag}>`);
      if (check.id && !lower.includes(`id="${check.id.toLowerCase()}"`) && !lower.includes(`id='${check.id.toLowerCase()}'`)) {
        misses.push(`no element with id "${check.id}"`);
      }
      if (check.text && !stripTags(html).toLowerCase().includes(check.text.toLowerCase())) misses.push(`no text "${check.text}"`);
      const what = [check.tag && `<${check.tag}>`, check.id && `#${check.id}`, check.text && `"${check.text}"`].filter(Boolean).join(', ');
      return misses.length
        ? { passed: false, evidence: `${check.path}: ${misses.join(', ')}.` }
        : { passed: true, evidence: `${check.path} has ${what}.` };
    }
    default:
      return { passed: false, evidence: 'Unknown check.' };
  }
}

export async function verifyBuild(input: {
  runtime: ExecutionRuntime;
  task: DevTask;
  agent: AgentDefinition;
  plan: ExecutionPlan;
  /** Live secret values this process holds; none may appear in the build. */
  secrets: string[];
  at?: string;
}): Promise<VerificationOutcome> {
  const { runtime, task, agent, plan } = input;
  const ws = runtime.workspaces;
  const checks: Check[] = [];

  // tests
  const reruns = await runtime.rerunTests({ workspaceId: task.workspaceId, agent, plan });
  const testsPassed = reruns.length > 0 && reruns.every((r) => r.status === 'passed');
  checks.push({
    check: 'tests',
    passed: testsPassed,
    evidence: reruns.length
      ? reruns.map((r) => `${r.id}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('; ')
      : 'The plan has no test step.',
  });

  // output
  const entryPath = `${plan.output.dir}/${plan.output.entry}`;
  const entryExists = (await ws.readBytes(task.workspaceId, entryPath)) !== null;
  checks.push({ check: 'output', passed: entryExists, evidence: entryExists ? `${entryPath} exists.` : `${entryPath} was not built.` });

  // artifact
  const recorded = task.blackboard.lastResult?.artifact ?? null;
  const archive = await ws.readBytes(task.workspaceId, ARTIFACT_PATH);
  let artifactOk = false;
  let artifactEvidence = 'No artifact was packaged.';
  if (archive && recorded) {
    const actual = sha256(archive);
    if (actual !== recorded.sha256) {
      artifactEvidence = 'The artifact on disk does not match the checksum recorded when it was packaged.';
    } else {
      try {
        const listed = listTarGz(archive);
        artifactOk = listed.some((e) => e.path === plan.output.entry);
        artifactEvidence = artifactOk
          ? `${listed.length} files, sha256 ${actual.slice(0, 16)}…, contains ${plan.output.entry}.`
          : `The artifact does not contain ${plan.output.entry}.`;
      } catch {
        artifactEvidence = 'The artifact is not a readable archive.';
      }
    }
  }
  checks.push({ check: 'artifact', passed: artifactOk, evidence: artifactEvidence });

  // budget
  const withinBudget = task.spentMinor <= task.maxBudgetMinor && task.reservedMinor === 0;
  checks.push({
    check: 'budget',
    passed: withinBudget,
    evidence: `Spent ${task.spentMinor} of ${task.maxBudgetMinor}; ${task.reservedMinor} still reserved.`,
  });

  // isolation
  const scan = await ws.scan(task.workspaceId);
  const isolated = scan.irregular.length === 0 && scan.totalBytes <= MAX_WORKSPACE_BYTES;
  checks.push({
    check: 'isolation',
    passed: isolated,
    evidence: scan.irregular.length
      ? `Links or special files in the workspace: ${scan.irregular.slice(0, 5).join(', ')}.`
      : scan.totalBytes > MAX_WORKSPACE_BYTES
        ? `The workspace is ${scan.totalBytes} bytes, over the ${MAX_WORKSPACE_BYTES} limit.`
        : `${scan.files.length} regular files, ${scan.totalBytes} bytes, all inside the workspace.`,
  });

  // secrets
  const live = input.secrets.filter((s) => s && s.length >= 8);
  let leaked: string | null = null;
  if (live.length) {
    for (const f of scan.files) {
      if (f.bytes > 2_000_000) continue;
      const text = await ws.readText(task.workspaceId, f.path);
      if (text && live.some((s) => text.includes(s))) {
        leaked = f.path;
        break;
      }
    }
  }
  checks.push({ check: 'secrets', passed: leaked === null, evidence: leaked ? `A live secret appears in ${leaked}.` : 'No live secret appears in the build.' });

  // engine
  if (agent.tools.includes('engine')) {
    const game = await checkGameManifest(ws, task.workspaceId, plan.output.dir);
    checks.push({ check: 'engine', passed: game.ok, evidence: game.ok ? 'Valid RazeKit game manifest and runtime.' : game.problems.join(' ') });
    // The game is played, not just inspected.
    const played = await runtime.playtest({ workspaceId: task.workspaceId, outputDir: plan.output.dir });
    checks.push({
      check: 'playtest',
      passed: played.ok,
      evidence: played.ok
        ? `Played ${played.frames} steps headlessly: no crash, replay identical, ${played.restarts} restart(s), average step ${played.averageMs!.toFixed(3)} ms, slowest ${played.worstMs!.toFixed(2)} ms.`
        : played.problems.join(' '),
    });
  }

  // acceptance
  const review = task.blackboard.lastReview;
  const acceptance: AcceptanceCriterion[] = [];
  for (const c of task.acceptance) {
    if (c.check) {
      const r = await evaluateCheck(runtime, task, c.check, { testsPassed, artifactOk });
      acceptance.push({ ...c, status: r.passed ? 'passed' : 'failed', evidence: r.evidence });
    } else {
      const judged = review?.criteria.find((j) => j.id === c.id);
      acceptance.push({
        ...c,
        status: judged?.met ? 'passed' : 'failed',
        evidence: judged ? `Judged by review, not machine-checked: ${judged.note}` : 'Not machine-checkable, and the review did not judge it.',
      });
    }
  }
  const acceptanceFailures = acceptance.filter((c) => c.status !== 'passed');
  checks.push({
    check: 'acceptance',
    passed: acceptanceFailures.length === 0,
    evidence: `${acceptance.length - acceptanceFailures.length} of ${acceptance.length} criteria met.`,
  });

  const failures = [
    ...checks.filter((c) => !c.passed).map((c) => ({ check: c.check, reason: c.evidence })),
    ...acceptanceFailures.map((c) => ({ check: `acceptance:${c.id}`, reason: `${c.text}: ${c.evidence}` })),
  ];

  return {
    report: {
      status: failures.length ? 'failed' : 'passed',
      failures,
      checks,
      checkedAt: input.at ?? new Date().toISOString(),
    },
    acceptance,
  };
}
