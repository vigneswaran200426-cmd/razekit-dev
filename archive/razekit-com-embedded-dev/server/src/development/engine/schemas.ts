// What a model is allowed to hand back, and the check it has to pass.
//
// Each output has a JSON schema (sent to the provider as a structured-output
// format, so a well-behaved model cannot produce anything else) and a
// validator (run on whatever comes back anyway, because "the provider
// promised" is not a security property). The validator is the one that
// counts: it re-checks every path, every step against the tool broker, and
// every size limit, and anything it refuses never reaches the workspace.
import type { AgentDefinition } from './agents.js';
import { planOrder } from './dag.js';
import { DevError, ERR } from './errors.js';
import { safeRelativePath } from './paths.js';
import { authorizeStep, type ToolAvailability } from './tools.js';
import {
  TOOL_NAMES,
  type AcceptanceCheck,
  type ArchitecturePlan,
  type ExecutionPlan,
  type ReviewVerdict,
  type ToolName,
} from './types.js';

export const LIMITS = {
  planFiles: 60,
  planCriteria: 30,
  files: 60,
  fileBytes: 300_000,
  totalBytes: 1_500_000,
  text: 2_000,
};

const nullable = (type: string) => ({ type: [type, 'null'] });
const str = { type: 'string' };

// Object-or-null as anyOf: the form both providers' strict structured-output
// modes accept for a nullable object.
const CHECK_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'path', 'tag', 'id', 'text'],
      properties: {
        type: { type: 'string', enum: ['file_exists', 'html_has', 'tests_pass', 'artifact_packaged'] },
        path: nullable('string'),
        tag: nullable('string'),
        id: nullable('string'),
        text: nullable('string'),
      },
    },
    { type: 'null' },
  ],
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dir', 'entry'],
  properties: { dir: str, entry: str },
};

export const ARCHITECTURE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'stack', 'files', 'acceptance', 'output'],
  properties: {
    summary: str,
    stack: str,
    files: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'purpose'], properties: { path: str, purpose: str } },
    },
    acceptance: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'check'], properties: { text: str, check: CHECK_SCHEMA } },
    },
    output: OUTPUT_SCHEMA,
  },
};

export const EXECUTION_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files', 'steps', 'output', 'notes'],
  properties: {
    files: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: str, content: str } },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'tool', 'args', 'dependsOn', 'description'],
        properties: {
          id: str,
          tool: { type: 'string', enum: [...TOOL_NAMES] },
          args: { type: 'array', items: str },
          dependsOn: { type: 'array', items: str },
          description: str,
        },
      },
    },
    output: OUTPUT_SCHEMA,
    notes: str,
  },
};

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'summary', 'issues', 'criteria'],
  properties: {
    decision: { type: 'string', enum: ['pass', 'revise', 'block'] },
    summary: str,
    issues: { type: 'array', items: str },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'met', 'note'],
        properties: { id: str, met: { type: 'boolean' }, note: str },
      },
    },
  },
};

function bad(message: string): DevError {
  return new DevError(ERR.PROVIDER_OUTPUT, message);
}

const text = (v: unknown, max = LIMITS.text) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses JSON a model produced, tolerating a fenced code block around it. */
export function parseModelJson(raw: string): unknown {
  const trimmed = String(raw ?? '').trim();
  const unfenced = trimmed.startsWith('```') ? trimmed.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '') : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    throw bad('The model did not return valid JSON.');
  }
}

export function validateCheck(raw: unknown): AcceptanceCheck | null {
  if (raw == null) return null;
  if (!isObj(raw)) throw bad('An acceptance check must be an object or null.');
  switch (raw.type) {
    case 'tests_pass':
      return { type: 'tests_pass' };
    case 'artifact_packaged':
      return { type: 'artifact_packaged' };
    case 'file_exists':
      return { type: 'file_exists', path: safeRelativePath(raw.path) };
    case 'html_has': {
      const tag = raw.tag ? String(raw.tag).toLowerCase() : undefined;
      const id = raw.id ? String(raw.id) : undefined;
      const t = raw.text ? String(raw.text).slice(0, 200) : undefined;
      if (tag && !/^[a-z][a-z0-9-]{0,30}$/.test(tag)) throw bad(`Invalid tag in check: ${tag}`);
      if (id && !/^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(id)) throw bad(`Invalid id in check: ${id}`);
      if (!tag && !id && !t) throw bad('An html_has check needs a tag, an id or text.');
      return { type: 'html_has', path: safeRelativePath(raw.path), ...(tag ? { tag } : {}), ...(id ? { id } : {}), ...(t ? { text: t } : {}) };
    }
    default:
      throw bad(`Unknown acceptance check type ${JSON.stringify(raw.type)}.`);
  }
}

function validateOutput(raw: unknown) {
  if (!isObj(raw)) throw bad('The plan must say where the build output goes.');
  return { dir: safeRelativePath(raw.dir), entry: safeRelativePath(raw.entry) };
}

export function validateArchitecturePlan(raw: unknown): ArchitecturePlan {
  if (!isObj(raw)) throw bad('The plan must be an object.');
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw bad('The plan must list the files it will write.');
  if (raw.files.length > LIMITS.planFiles) throw bad(`The plan lists more than ${LIMITS.planFiles} files.`);
  if (!Array.isArray(raw.acceptance)) throw bad('The plan must state its acceptance criteria.');
  if (raw.acceptance.length > LIMITS.planCriteria) throw bad(`The plan has more than ${LIMITS.planCriteria} criteria.`);
  return {
    summary: text(raw.summary),
    stack: text(raw.stack, 300),
    files: raw.files.map((f: any) => ({ path: safeRelativePath(f?.path), purpose: text(f?.purpose, 300) })),
    acceptance: raw.acceptance.map((a: any) => ({ text: text(a?.text, 300), check: validateCheck(a?.check) })),
    output: validateOutput(raw.output),
  };
}

export function validateExecutionPlan(
  raw: unknown,
  agent: AgentDefinition,
  availability: ToolAvailability,
  reservedPaths: string[] = []
): ExecutionPlan {
  if (!isObj(raw)) throw bad('The implementation must be an object.');
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw bad('The implementation wrote no files.');
  if (raw.files.length > LIMITS.files) throw bad(`The implementation wrote more than ${LIMITS.files} files.`);

  let total = 0;
  const seen = new Set<string>();
  const files = raw.files.map((f: any) => {
    const p = safeRelativePath(f?.path);
    if (seen.has(p)) throw bad(`The file ${p} is written twice.`);
    if (reservedPaths.includes(p)) throw bad(`${p} is provided by RazeKit and cannot be rewritten.`);
    seen.add(p);
    if (typeof f?.content !== 'string') throw bad(`The file ${p} has no content.`);
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > LIMITS.fileBytes) throw bad(`The file ${p} is larger than ${LIMITS.fileBytes} bytes.`);
    total += bytes;
    return { path: p, content: f.content as string };
  });
  if (total > LIMITS.totalBytes) throw bad(`The implementation is larger than ${LIMITS.totalBytes} bytes in total.`);

  if (!Array.isArray(raw.steps)) throw bad('The implementation must say how to test and build it.');
  const steps = raw.steps.map((s: any) => ({
    id: String(s?.id ?? ''),
    tool: String(s?.tool ?? '') as ToolName,
    args: Array.isArray(s?.args) ? s.args.map((a: unknown) => String(a)) : [],
    dependsOn: Array.isArray(s?.dependsOn) ? s.dependsOn.map((d: unknown) => String(d)) : [],
    description: text(s?.description, 300),
  }));
  planOrder(steps);
  // Every step is put through the broker now, so a plan with one forbidden
  // step is refused whole rather than half-executed.
  for (const step of steps) authorizeStep(agent, step, availability);
  if (!steps.some((s: { tool: string }) => s.tool === 'test')) throw bad('The implementation must include a test step.');
  if (!steps.some((s: { tool: string }) => s.tool === 'package')) throw bad('The implementation must package its output.');

  return { files, steps, output: validateOutput(raw.output), notes: text(raw.notes, 1_000) };
}

export function validateReview(raw: unknown): ReviewVerdict {
  if (!isObj(raw)) throw bad('The review must be an object.');
  if (!['pass', 'revise', 'block'].includes(raw.decision)) throw bad('The review must decide pass, revise or block.');
  return {
    decision: raw.decision,
    summary: text(raw.summary),
    issues: Array.isArray(raw.issues) ? raw.issues.slice(0, 30).map((i: unknown) => text(i, 500)) : [],
    criteria: Array.isArray(raw.criteria)
      ? raw.criteria.slice(0, 60).map((c: any) => ({ id: text(c?.id, 80), met: c?.met === true, note: text(c?.note, 500) }))
      : [],
  };
}


/**
 * Astra's structured analysis of RazeKit DEV's own operation: a Battle Mode
 * challenge or a Dev Department root cause. A decision record, never prose.
 */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'problem', 'rootCause', 'evidence', 'proposedChange', 'expectedGain', 'risk', 'acceptanceCriteria', 'benchmark', 'rollbackPlan'],
  properties: {
    decision: { type: 'string', enum: ['NO_CHANGE', 'IMPROVE', 'REPAIR', 'BLOCK', 'ESCALATE'] },
    problem: { type: 'string' },
    rootCause: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    proposedChange: { type: 'string' },
    expectedGain: { type: 'string' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    benchmark: { type: 'string' },
    rollbackPlan: { type: 'string' },
  },
} as const;

export interface Analysis {
  decision: 'NO_CHANGE' | 'IMPROVE' | 'REPAIR' | 'BLOCK' | 'ESCALATE';
  problem: string;
  rootCause: string;
  evidence: string[];
  proposedChange: string;
  expectedGain: string;
  risk: 'low' | 'medium' | 'high';
  acceptanceCriteria: string[];
  benchmark: string;
  rollbackPlan: string;
}

/** Refuses anything that is not exactly an Analysis. */
export function validateAnalysis(raw: unknown): Analysis {
  const a = raw as any;
  const str = (v: unknown, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const list = (v: unknown) => Array.isArray(v) && v.length <= 20 && v.every((x) => str(x, 1000));
  const ok =
    a && typeof a === 'object' &&
    ['NO_CHANGE', 'IMPROVE', 'REPAIR', 'BLOCK', 'ESCALATE'].includes(a.decision) &&
    ['low', 'medium', 'high'].includes(a.risk) &&
    ['problem', 'rootCause', 'proposedChange', 'expectedGain', 'benchmark', 'rollbackPlan'].every((k) => str(a[k])) &&
    list(a.evidence) && list(a.acceptanceCriteria);
  if (!ok) throw new DevError(ERR.PROVIDER_OUTPUT, 'The analysis was not in the required shape.', { retryable: false });
  return {
    decision: a.decision, problem: a.problem, rootCause: a.rootCause, evidence: a.evidence, proposedChange: a.proposedChange,
    expectedGain: a.expectedGain, risk: a.risk, acceptanceCriteria: a.acceptanceCriteria, benchmark: a.benchmark, rollbackPlan: a.rollbackPlan,
  };
}
