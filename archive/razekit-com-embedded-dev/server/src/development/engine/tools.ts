// The tool broker.
//
// A model never runs a command. It names a tool and supplies arguments; the
// broker decides whether that agent may use that tool, whether the runtime
// actually has it, and then builds the command line itself. So the argv that
// reaches a process is always RazeKit's, with only validated workspace paths
// substituted in — there is no string a model can write that becomes a shell,
// a flag to node, a network fetch or a path outside the workspace.
//
// Tools that are not attached to this deployment (a browser, a deploy target,
// the npm registry) are refused with the reason, never pretended.
import type { AgentDefinition } from './agents.js';
import { DevError, ERR } from './errors.js';
import { safeRelativePath } from './paths.js';
import type { ExecutionStep, ToolName } from './types.js';

export interface ToolSpec {
  name: ToolName;
  kind: 'files' | 'process' | 'builtin' | 'external';
  description: string;
}

export const TOOLS: Readonly<Record<ToolName, ToolSpec>> = {
  files: { name: 'files', kind: 'files', description: 'Writes the planned files into the workspace.' },
  node: { name: 'node', kind: 'process', description: 'Runs a workspace script with Node.' },
  test: { name: 'test', kind: 'process', description: 'Runs workspace tests with the Node test runner.' },
  build: { name: 'build', kind: 'process', description: 'Runs the workspace build script.' },
  package: { name: 'package', kind: 'builtin', description: 'Packages the build output into a checksummed artifact.' },
  engine: { name: 'engine', kind: 'builtin', description: 'Validates the game manifest against the RazeKit game runtime.' },
  browser: { name: 'browser', kind: 'external', description: 'Loads the built page in a headless browser.' },
  'deploy-web': { name: 'deploy-web', kind: 'external', description: 'Publishes the build to a web host.' },
  npm: { name: 'npm', kind: 'external', description: 'Installs packages from the npm registry.' },
};

export type ToolAvailability = Record<ToolName, { available: boolean; reason?: string }>;

/**
 * What the runtime can actually do. The defaults are the truth about this
 * deployment: no browser is attached, no deploy target is connected, and
 * builds have no registry access, so dependency-free code is the only kind
 * that can build.
 */
export function defaultAvailability(overrides: Partial<ToolAvailability> = {}): ToolAvailability {
  return {
    files: { available: true },
    node: { available: true },
    test: { available: true },
    build: { available: true },
    package: { available: true },
    engine: { available: true },
    browser: { available: false, reason: 'No browser runtime is attached to this deployment.' },
    'deploy-web': { available: false, reason: 'No deployment target is connected.' },
    npm: { available: false, reason: 'Builds have no package registry access; code must be dependency-free.' },
    ...overrides,
  };
}

/**
 * A step the runtime may execute. A process step is one or more Node
 * invocations, each an argv RazeKit built; the step passes only if every one
 * exits cleanly within the step's shared deadline.
 */
export type AuthorizedStep =
  | { step: ExecutionStep; kind: 'process'; exe: 'node'; invocations: string[][]; timeoutMs: number }
  | { step: ExecutionStep; kind: 'builtin'; builtin: 'package' | 'engine'; timeoutMs: number };

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_SCRIPT_ARGS = 10;

function denied(message: string) {
  return new DevError(ERR.TOOL_DENIED, message);
}

function scriptPath(value: unknown, what: string): string {
  const p = safeRelativePath(value);
  if (!p.endsWith('.mjs')) throw denied(`${what} must be an .mjs file inside the workspace, got ${p}.`);
  return p;
}

/**
 * Turns a planned step into something the runtime may execute, or refuses it.
 *
 * Refusals are not retryable: a step the broker refuses will be refused again,
 * and the right response is a different plan, not another attempt.
 */
export function authorizeStep(agent: AgentDefinition, step: ExecutionStep, availability: ToolAvailability): AuthorizedStep {
  const spec = TOOLS[step.tool as ToolName];
  if (!spec) throw denied(`Unknown tool ${JSON.stringify(step.tool)}.`);
  if (!agent.tools.includes(step.tool)) {
    throw denied(`${agent.label} may not use the ${step.tool} tool.`);
  }
  const avail = availability[step.tool];
  if (!avail?.available) {
    throw new DevError(ERR.TOOL_UNAVAILABLE, `The ${step.tool} tool is not available: ${avail?.reason || 'not attached'}`);
  }

  const timeoutMs = Math.min(Math.max(Number(step.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
  const args = Array.isArray(step.args) ? step.args : [];

  switch (step.tool) {
    case 'files':
      // Files are written from the plan before any step runs; a step that
      // "writes files" would be a second, unvalidated way to do it.
      throw denied('Files are written from the plan, not by a step.');
    case 'test': {
      if (args.length === 0) throw denied('A test step must name the test files it runs.');
      if (args.length > 50) throw denied('A test step may name at most 50 files.');
      const files = args.map((a) => {
        const p = safeRelativePath(a);
        if (!/\.test\.mjs$/.test(p)) throw denied(`Test files must end in .test.mjs, got ${p}.`);
        return p;
      });
      // Each test file runs as its own contained process. A node:test file run
      // directly executes its tests and exits non-zero if any fail, so no
      // test-runner child processes are needed — which the permission model
      // forbids — and it behaves the same on every supported Node version.
      return { step, kind: 'process', exe: 'node', invocations: files.map((f) => [f]), timeoutMs };
    }
    case 'build': {
      if (args.length !== 1) throw denied('A build step runs exactly one script.');
      return { step, kind: 'process', exe: 'node', invocations: [[scriptPath(args[0], 'The build script')]], timeoutMs };
    }
    case 'node': {
      if (args.length < 1) throw denied('A node step must name its script.');
      if (args.length > MAX_SCRIPT_ARGS + 1) throw denied('Too many script arguments.');
      const script = scriptPath(args[0], 'The script');
      const rest = args.slice(1).map((a) => {
        const v = String(a);
        if (v.length > 200 || /[\0\n\r]/.test(v)) throw denied('Script arguments must be short, single-line strings.');
        return v;
      });
      // The script path comes first, so everything after it is the script's
      // own argv — never a flag Node itself would interpret.
      return { step, kind: 'process', exe: 'node', invocations: [[script, ...rest]], timeoutMs };
    }
    case 'package':
      return { step, kind: 'builtin', builtin: 'package', timeoutMs };
    case 'engine':
      return { step, kind: 'builtin', builtin: 'engine', timeoutMs };
    default:
      throw new DevError(ERR.TOOL_UNAVAILABLE, `The ${step.tool} tool cannot be run by this runtime.`);
  }
}

/** The tools an agent can use right now, and the ones it cannot with the reason. */
export function agentToolset(agent: AgentDefinition, availability: ToolAvailability) {
  const usable = agent.tools.filter((t) => availability[t]?.available);
  const unavailable = agent.tools
    .filter((t) => !availability[t]?.available)
    .map((tool) => ({ tool, reason: availability[tool]?.reason || 'not attached' }));
  return { usable, unavailable };
}
