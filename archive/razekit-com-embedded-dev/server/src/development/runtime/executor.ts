// Execution runtimes: where a plan becomes files, processes and an artifact.
//
//   local    A contained process on the worker (see process.ts). For
//            development, tests and the local end-to-end check. Refused in
//            production.
//   sandbox  A per-build container or microVM. Not attached: it needs cloud
//            infrastructure this deployment does not have yet. It reports
//            itself unavailable with that reason rather than quietly running
//            builds somewhere less isolated.
//
// Both run steps in dependency order through the tool broker, and a step whose
// dependency failed is skipped rather than run on broken ground.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDefinition } from '../engine/agents.js';
import { planOrder, stepDisposition } from '../engine/dag.js';
import { DevError, ERR } from '../engine/errors.js';
import { GAME_RUNTIME_DESCRIPTION, GAME_RUNTIME_PATH, GAME_RUNTIME_SOURCE } from '../engine/gameRuntime.js';
import { authorizeStep, defaultAvailability, type ToolAvailability } from '../engine/tools.js';
import { boundOutput, redact } from '../engine/trust.js';
import type { ExecutionPlan, ExecutionResult, FileRecord, StepResult } from '../engine/types.js';
import { checkGameManifest } from './engineCheck.js';
import { tarGz } from './packager.js';
import { runPlaytest, type PlaytestReport } from '../konami/playtest.js';
import { runNode, type ProcessResult } from './process.js';
import { ARTIFACTS_DIR, sha256, Workspaces } from './workspace.js';

export const ARTIFACT_PATH = `${ARTIFACTS_DIR}/build.tar.gz`;

export interface ProvidedFile {
  path: string;
  content: string;
  description: string;
}

export interface ExecuteInput {
  workspaceId: string;
  agent: AgentDefinition;
  plan: ExecutionPlan;
}

export interface ExecutionRuntime {
  readonly kind: 'local' | 'sandbox';
  readonly status: { available: boolean; reason?: string };
  readonly workspaces: Workspaces;
  availability(): ToolAvailability;
  providedFiles(agent: AgentDefinition): ProvidedFile[];
  execute(input: ExecuteInput): Promise<ExecutionResult>;
  /** Runs the plan's test steps again, for verification. Nothing else. */
  rerunTests(input: ExecuteInput): Promise<StepResult[]>;
  /** Plays a built game headlessly under the same containment. */
  playtest(input: { workspaceId: string; outputDir: string }): Promise<PlaytestReport>;
}

export function providedFilesFor(agent: AgentDefinition): ProvidedFile[] {
  return agent.tools.includes('engine')
    ? [{ path: GAME_RUNTIME_PATH, content: GAME_RUNTIME_SOURCE, description: GAME_RUNTIME_DESCRIPTION }]
    : [];
}

export class LocalRuntime implements ExecutionRuntime {
  readonly kind: 'local' | 'sandbox' = 'local';
  readonly status: { available: boolean; reason?: string } = { available: true };
  readonly workspaces: Workspaces;
  protected secrets: string[];
  protected memoryMb: number;

  constructor(opts: { root: string; secrets?: string[]; memoryMb?: number }) {
    this.workspaces = new Workspaces(opts.root);
    this.secrets = (opts.secrets ?? []).filter(Boolean);
    this.memoryMb = opts.memoryMb ?? 256;
  }

  availability(): ToolAvailability {
    return defaultAvailability();
  }

  providedFiles(agent: AgentDefinition) {
    return providedFilesFor(agent);
  }

  async execute({ workspaceId, agent, plan }: ExecuteInput): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const provided = this.providedFiles(agent);
    const filesWritten = await this.workspaces.replaceSource(workspaceId, [
      ...provided.map((p) => ({ path: p.path, content: p.content })),
      ...plan.files,
    ]);
    const steps = await this.runSteps(workspaceId, agent, plan, plan.steps);
    const artifactStep = steps.find((s) => s.tool === 'package' && s.status === 'passed');
    let artifact: FileRecord | null = null;
    if (artifactStep) {
      const bytes = await this.workspaces.readBytes(workspaceId, ARTIFACT_PATH);
      if (bytes) artifact = { path: ARTIFACT_PATH, bytes: bytes.length, sha256: sha256(bytes) };
    }
    return {
      runId: `run_${randomUUID().slice(0, 12)}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: steps.length > 0 && steps.every((s) => s.status === 'passed'),
      steps,
      filesWritten,
      artifact,
    };
  }

  playtest({ workspaceId, outputDir }: { workspaceId: string; outputDir: string }): Promise<PlaytestReport> {
    return runPlaytest(this.workspaces, workspaceId, outputDir, { invoke: (argv, timeoutMs) => this.invoke(workspaceId, argv, timeoutMs) });
  }

  /**
   * Runs one broker-built `node` invocation against the workspace, contained.
   * The one place build code actually executes: here as a local process under
   * Node's permission model; a sandboxed runtime runs it somewhere else.
   */
  protected invoke(workspaceId: string, argv: string[], timeoutMs: number): Promise<ProcessResult> {
    return runNode({ cwd: this.workspaces.pathFor(workspaceId), args: argv, timeoutMs, memoryMb: this.memoryMb });
  }

  async rerunTests({ workspaceId, agent, plan }: ExecuteInput): Promise<StepResult[]> {
    const tests = plan.steps.filter((s) => s.tool === 'test').map((s) => ({ ...s, dependsOn: [] }));
    return this.runSteps(workspaceId, agent, plan, tests);
  }

  private async runSteps(workspaceId: string, agent: AgentDefinition, plan: ExecutionPlan, steps: ExecutionPlan['steps']): Promise<StepResult[]> {
    const results = new Map<string, StepResult>();
    const byId = new Map(steps.map((s) => [s.id, s]));
    for (const id of planOrder(steps)) {
      const step = byId.get(id)!;
      if (stepDisposition(step, results) === 'skip') {
        results.set(id, { id, tool: step.tool, status: 'skipped', exitCode: null, durationMs: 0, output: '', error: 'A step it depends on did not pass.' });
        continue;
      }
      const started = Date.now();
      try {
        const authorized = authorizeStep(agent, step, this.availability());
        if (authorized.kind === 'process') {
          // One shared deadline for the whole step, however many invocations
          // it has, and the first failure ends it.
          const deadline = started + authorized.timeoutMs;
          const outputs: string[] = [];
          let failure: { exitCode: number | null; error: string } | null = null;
          for (const argv of authorized.invocations) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              failure = { exitCode: null, error: 'Timed out.' };
              break;
            }
            const r = await this.invoke(workspaceId, argv, remaining);
            outputs.push(authorized.invocations.length > 1 ? `$ node ${argv.join(' ')}\n${r.output}` : r.output);
            if (r.exitCode !== 0 || r.timedOut) {
              failure = { exitCode: r.exitCode, error: r.timedOut ? 'Timed out.' : `Exited with ${r.exitCode ?? r.signal}.` };
              break;
            }
          }
          results.set(id, {
            id,
            tool: step.tool,
            status: failure ? 'failed' : 'passed',
            exitCode: failure ? failure.exitCode : 0,
            durationMs: Date.now() - started,
            output: boundOutput(redact(outputs.join('\n'), this.secrets)),
            ...(failure ? { error: failure.error } : {}),
          });
        } else if (authorized.builtin === 'package') {
          results.set(id, await this.packageOutput(workspaceId, plan, id, started));
        } else {
          const check = await checkGameManifest(this.workspaces, workspaceId, plan.output.dir);
          results.set(id, {
            id,
            tool: step.tool,
            status: check.ok ? 'passed' : 'failed',
            exitCode: check.ok ? 0 : 1,
            durationMs: Date.now() - started,
            output: check.ok ? 'game.json is valid for the RazeKit game runtime.' : check.problems.join('\n'),
            ...(check.ok ? {} : { error: check.problems[0] }),
          });
        }
      } catch (e) {
        // A refused step is a failed step with the refusal as its reason. It
        // is not retried: the same plan would be refused the same way.
        results.set(id, {
          id,
          tool: step.tool,
          status: 'failed',
          exitCode: null,
          durationMs: Date.now() - started,
          output: '',
          error: redact((e as Error).message, this.secrets),
        });
      }
    }
    return steps.map((s) => results.get(s.id)!).filter(Boolean);
  }

  private async packageOutput(workspaceId: string, plan: ExecutionPlan, id: string, started: number): Promise<StepResult> {
    const scan = await this.workspaces.scan(workspaceId, plan.output.dir);
    if (scan.irregular.length) {
      return { id, tool: 'package', status: 'failed', exitCode: 1, durationMs: Date.now() - started, output: '', error: `The output contains links or special files: ${scan.irregular.join(', ')}` };
    }
    if (!scan.files.length) {
      return { id, tool: 'package', status: 'failed', exitCode: 1, durationMs: Date.now() - started, output: '', error: `Nothing was built into ${plan.output.dir}/.` };
    }
    const prefix = `${plan.output.dir}/`;
    const entries = [];
    for (const f of scan.files) {
      const data = await this.workspaces.readBytes(workspaceId, f.path);
      if (data) entries.push({ path: f.path.slice(prefix.length), data });
    }
    const archive = tarGz(entries);
    const target = path.join(this.workspaces.pathFor(workspaceId), ARTIFACT_PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, archive, { mode: 0o600 });
    return {
      id,
      tool: 'package',
      status: 'passed',
      exitCode: 0,
      durationMs: Date.now() - started,
      output: `Packaged ${entries.length} files (${archive.length} bytes, sha256 ${sha256(archive).slice(0, 16)}…).`,
    };
  }
}

/** The per-build sandbox. Not attached to this deployment, and says so. */
export class SandboxRuntime implements ExecutionRuntime {
  readonly kind = 'sandbox' as const;
  readonly status: { available: boolean; reason?: string };
  readonly workspaces: Workspaces;

  constructor(opts: { root: string; reason?: string }) {
    this.workspaces = new Workspaces(opts.root);
    this.status = {
      available: false,
      reason: opts.reason ?? 'No sandboxed build runtime is attached. It needs per-build container infrastructure, which is not provisioned.',
    };
  }

  availability(): ToolAvailability {
    const off = { available: false, reason: this.status.reason };
    return { files: off, node: off, test: off, build: off, package: off, engine: off, browser: off, 'deploy-web': off, npm: off };
  }

  providedFiles(agent: AgentDefinition) {
    return providedFilesFor(agent);
  }

  async execute(): Promise<ExecutionResult> {
    throw new DevError(ERR.RUNTIME_UNAVAILABLE, this.status.reason!, { httpStatus: 503 });
  }

  async rerunTests(): Promise<StepResult[]> {
    throw new DevError(ERR.RUNTIME_UNAVAILABLE, this.status.reason!, { httpStatus: 503 });
  }

  async playtest(): Promise<PlaytestReport> {
    throw new DevError(ERR.RUNTIME_UNAVAILABLE, this.status.reason!, { httpStatus: 503 });
  }
}
