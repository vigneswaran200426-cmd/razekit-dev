// What Astra and Fable are told.
//
// Instructions and data are kept apart by construction: the system prompt is
// RazeKit's own words and never contains anything a user or a tool wrote;
// every such thing reaches the model inside a fence (see trust.ts). The rules
// that matter for safety are also enforced after the fact by the validators —
// the prompt asks nicely, the validator does not.
import type { AgentDefinition } from './agents.js';
import { fence, TRUST_PREAMBLE } from './trust.js';
import type {
  AcceptanceCriterion,
  ArchitecturePlan,
  DevTask,
  ExecutionPlan,
  ExecutionResult,
  ReviewVerdict,
  ToolName,
} from './types.js';

export interface PlanRequest {
  task: DevTask;
  agent: AgentDefinition;
  usableTools: ToolName[];
  unavailableTools: { tool: ToolName; reason: string }[];
}

export interface ImplementRequest {
  task: DevTask;
  agent: AgentDefinition;
  plan: ArchitecturePlan;
  previous: ExecutionPlan | null;
  lastResult: ExecutionResult | null;
  review: ReviewVerdict | null;
  refinements: { id: string; content: string }[];
  repairNotes: string[];
  usableTools: ToolName[];
  /** Files RazeKit provides that the build may import and must not rewrite. */
  providedFiles: { path: string; description: string }[];
}

export interface ReviewRequest {
  task: DevTask;
  agent: AgentDefinition;
  plan: ArchitecturePlan;
  executionPlan: ExecutionPlan;
  result: ExecutionResult;
  criteria: AcceptanceCriterion[];
}

const RUNTIME_RULES = [
  'The build runs in an isolated workspace with Node.js 20+ and no network access, so it must be dependency-free: no npm packages, no CDN links, no external fonts or images.',
  'All JavaScript is ES modules in .mjs files. Scripts run under the Node permission model: they may read and write only inside the workspace, and may not spawn processes or workers.',
  'Tests use node:test and node:assert and live in tests/ with names ending .test.mjs. Each test file is run on its own as `node <file>` from the workspace root, so it must pass or fail by itself. Test pure logic and the structure of what is built; tests cannot open a browser.',
  'build.mjs writes the finished, static output into the output directory. The output must work when its entry file is opened in a browser with no server-side code.',
  'Every path is relative, uses forward slashes and plain names (letters, digits, ".", "_", "-"). No hidden files.',
].join('\n');

const CHECK_VOCABULARY = [
  'Acceptance checks are how "done" is verified, by RazeKit, against the built output:',
  '- {"type":"file_exists","path":P}: P exists in the workspace (use the output dir for built files).',
  '- {"type":"html_has","path":P,"tag":T,"id":I,"text":X}: the HTML file P contains an element <T>, an element with id="I", and/or the text X. Unused fields are null.',
  '- {"type":"tests_pass"}: the test step passes when RazeKit re-runs it.',
  '- {"type":"artifact_packaged"}: the output was packaged into a checksummed artifact.',
  'Use null for a criterion that cannot be checked mechanically; it is then judged at review.',
].join('\n');

function taskFacts(task: DevTask, agent: AgentDefinition) {
  return [
    `Agent: ${agent.label}. ${agent.brief}`,
    `Build type: ${task.taskType}.`,
    fence('title', task.title, 200),
    fence('request', task.originalRequest),
  ].join('\n');
}

export function planPrompt(req: PlanRequest) {
  const system = [
    TRUST_PREAMBLE,
    'You are Astra, the architect. Turn the customer request into a concrete plan another engineer will implement.',
    RUNTIME_RULES,
    CHECK_VOCABULARY,
    `Tools available to this build: ${req.usableTools.join(', ')}.`,
    req.unavailableTools.length
      ? `Not available (do not plan for them): ${req.unavailableTools.map((u) => `${u.tool} (${u.reason})`).join('; ')}.`
      : '',
    'Plan the smallest complete thing that satisfies the request. Every criterion the customer gave must appear in acceptance, mapped to a check where one fits.',
    'Respond only with JSON matching the provided schema.',
  ].filter(Boolean).join('\n\n');

  const criteria = req.task.acceptance.map((c) => ({ id: c.id, text: c.text }));
  const user = [
    taskFacts(req.task, req.agent),
    criteria.length ? fence('customer_criteria', criteria) : 'The customer gave no explicit criteria.',
  ].join('\n\n');
  return { system, user };
}

export function implementPrompt(req: ImplementRequest) {
  const repairing = Boolean(req.lastResult && !req.lastResult.ok) || req.review?.decision === 'revise';
  const system = [
    TRUST_PREAMBLE,
    'You are Fable, the implementer. Write the complete codebase for the plan: every file in full, never a placeholder or an ellipsis.',
    RUNTIME_RULES,
    [
      'Steps are run by RazeKit through a tool broker. Each step names a tool and arguments:',
      '- test: args are the test files (tests/*.test.mjs); each is run as its own process.',
      '- build: args is ["build.mjs"].',
      '- node: args are a workspace script (.mjs) followed by its own arguments.',
      '- package: no args; packages the output directory. It must depend on the build step.',
      req.agent.tools.includes('engine') ? '- engine: no args; validates game.json against the RazeKit game runtime. It must depend on the build step.' : '',
      req.agent.tools.includes('engine')
        ? '- game.json must also declare "simulation": { "module": "<file in the output>", "factory": "<export>" }. factory({ seed }) returns { step(dt, input) } that advances the game without a DOM and returns its state (with over: true when a run ends); input keys are the names in "controls". Verification plays it headlessly for a minute of game time and fails a build that crashes, cannot replay the same seed identically, freezes, or is too slow.'
        : '',
      'Use dependsOn so build depends on test and package depends on build.',
    ].filter(Boolean).join('\n'),
    req.providedFiles.length
      ? `RazeKit provides these files; import them, never rewrite them:\n${req.providedFiles.map((f) => `- ${f.path}: ${f.description}`).join('\n')}`
      : '',
    repairing
      ? 'This is a repair. The previous attempt and what went wrong are below. Fix the cause, keep what already works, and return the complete codebase again.'
      : '',
    'Respond only with JSON matching the provided schema.',
  ].filter(Boolean).join('\n\n');

  const parts = [
    taskFacts(req.task, req.agent),
    fence('plan', req.plan),
  ];
  if (req.refinements.length) parts.push(fence('customer_refinements', req.refinements));
  if (req.previous) parts.push(fence('previous_files', req.previous.files.map((f) => ({ path: f.path, content: f.content })), 120_000));
  if (req.lastResult) {
    parts.push(fence('last_run', req.lastResult.steps.map((s) => ({ id: s.id, tool: s.tool, status: s.status, output: s.output.slice(-4000) })), 40_000));
  }
  if (req.review && req.review.decision !== 'pass') parts.push(fence('review', { summary: req.review.summary, issues: req.review.issues }));
  if (req.repairNotes.length) parts.push(fence('verification_failures', req.repairNotes));
  return { system, user: parts.join('\n\n') };
}

export function reviewPrompt(req: ReviewRequest) {
  const system = [
    TRUST_PREAMBLE,
    'You are Astra, the reviewer. Judge what was actually built and run — the files and the step results — against the plan and the customer request. Do not judge intentions or comments.',
    'Decide "pass" if it does what was asked and every step passed; "revise" with specific, actionable issues if it can be fixed by rewriting code; "block" only if it cannot be finished without the customer (for example it needs an external service, account or decision).',
    'For each criterion listed as needing judgement, say whether the built files meet it and why. Your judgement is shown as review, never as verification.',
    'Respond only with JSON matching the provided schema.',
  ].join('\n\n');

  const unchecked = req.criteria.filter((c) => !c.check).map((c) => ({ id: c.id, text: c.text }));
  const user = [
    taskFacts(req.task, req.agent),
    fence('plan', { summary: req.plan.summary, acceptance: req.plan.acceptance }),
    fence('files', req.executionPlan.files.map((f) => ({ path: f.path, content: f.content })), 120_000),
    fence('run', req.result.steps.map((s) => ({ id: s.id, tool: s.tool, status: s.status, exitCode: s.exitCode, output: s.output.slice(-3000) })), 30_000),
    unchecked.length ? fence('criteria_needing_judgement', unchecked) : 'No criteria need judgement.',
  ].join('\n\n');
  return { system, user };
}


export interface AnalysisRequest {
  purpose: 'battle-challenge' | 'incident-root-cause';
  subject: string;
  /** Measurements and records only; never customer content. */
  evidence: unknown;
}

export function analysisPrompt(req: AnalysisRequest) {
  const role =
    req.purpose === 'battle-challenge'
      ? 'You are Astra, challenging how RazeKit DEV itself performs. Given measurements from real builds, find the cause of the problem and propose the smallest change that would fix it without weakening any test, verification, security, authorization or budget check.'
      : 'You are Astra, finding the root cause of an incident in RazeKit DEV itself. Given the incident records, explain the cause and propose the smallest safe fix.';
  const system = [
    TRUST_PREAMBLE,
    role,
    'Speed or cost gained by skipping a check is not an improvement: reject such changes. Name what would prove the change works (a benchmark or test) and how to undo it.',
    'If the evidence is not enough to act on, say so — decide that no change is warranted, or escalate — rather than guessing.',
    'Respond only with JSON matching the provided schema.',
  ].join('\n\n');
  const user = [fence('subject', req.subject, 500), fence('evidence', req.evidence, 12000)].join('\n\n');
  return { system, user };
}
