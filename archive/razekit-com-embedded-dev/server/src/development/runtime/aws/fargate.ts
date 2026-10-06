// The sandboxed runtime: every build invocation in its own AWS Fargate task.
//
// A build's own code never runs on the worker. For each broker-built `node`
// invocation (a test step, a build step, the headless playtest) this runtime:
//
//   1. packs the workspace and the job into S3, under a per-run key;
//   2. starts ONE Fargate task from a fixed task definition — the RazeKit
//      runner image, no task-role permissions, private subnets whose only
//      route out is the S3 gateway endpoint — handing it two pre-signed URLs
//      and nothing else;
//   3. waits for it to stop (stopping it at the deadline), then takes the
//      workspace and result back from S3, refusing anything that is not a
//      regular file at a safe path, and deletes both objects.
//
// Fargate gives each task its own kernel and resources, so a build cannot see
// another build or the worker. RazeKit's own trusted steps (packaging, the
// manifest check) still run on the worker, on the files that came back.
//
// Starting the task uses the run id as ECS's idempotency token, so a retry
// after a lost answer finds the task it already started instead of starting a
// second one.
import { randomUUID } from 'node:crypto';
import { DevError, ERR } from '../../engine/errors.js';
import { safeRelativePath } from '../../engine/paths.js';
import { extractTarGz, tarGz } from '../packager.js';
import type { ProcessResult } from '../process.js';
import { ARTIFACTS_DIR } from '../workspace.js';
import { LocalRuntime } from '../executor.js';

export const JOB_FILE = 'razekit-job.json';
export const RESULT_FILE = 'razekit-result.json';

/** The ECS calls this runtime makes. The real client is @aws-sdk/client-ecs. */
export interface EcsLike {
  runTask(input: any): Promise<{ tasks?: { taskArn?: string }[]; failures?: { reason?: string }[] }>;
  describeTasks(input: any): Promise<{ tasks?: { lastStatus?: string; stopCode?: string; stoppedReason?: string; containers?: { exitCode?: number; reason?: string }[] }[] }>;
  stopTask(input: any): Promise<unknown>;
}

/** Object storage for run inputs and outputs. The real one is S3. */
export interface RunStorage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  presignPut(key: string, ttlSeconds: number): Promise<string>;
}

export interface FargateSettings {
  cluster: string;
  taskDefinition: string;
  containerName: string;
  subnets: string[];
  securityGroups: string[];
  prefix: string;
}

export class FargateRuntime extends LocalRuntime {
  override readonly kind = 'sandbox' as const;
  override readonly status: { available: boolean; reason?: string };

  constructor(
    opts: { root: string; secrets?: string[]; memoryMb?: number },
    private aws: { ecs: EcsLike; storage: RunStorage; settings: FargateSettings; pollMs?: number; startGraceMs?: number; sleep?: (ms: number) => Promise<void> }
  ) {
    super(opts);
    const s = aws.settings;
    const missing = [!s.cluster && 'cluster', !s.taskDefinition && 'task definition', !s.subnets.length && 'subnets', !s.securityGroups.length && 'security groups'].filter(Boolean);
    this.status = missing.length ? { available: false, reason: `The Fargate runtime is missing its ${missing.join(', ')}.` } : { available: true };
  }

  private sleep(ms: number) {
    return this.aws.sleep ? this.aws.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  protected override async invoke(workspaceId: string, argv: string[], timeoutMs: number): Promise<ProcessResult> {
    if (!this.status.available) throw new DevError(ERR.RUNTIME_UNAVAILABLE, this.status.reason!, { httpStatus: 503 });
    const runId = `run${randomUUID().replace(/-/g, '')}`;
    const base = `${this.aws.settings.prefix.replace(/\/$/, '')}/${workspaceId}/${runId}`;
    const inKey = `${base}/in.tar.gz`;
    const outKey = `${base}/out.tar.gz`;
    const started = Date.now();
    const graceMs = this.aws.startGraceMs ?? 5 * 60_000;
    const ttl = Math.ceil((timeoutMs + graceMs) / 1000) + 300;

    // 1. The workspace (not its artifacts) and the job, into S3.
    const scan = await this.workspaces.scan(workspaceId);
    const entries = [];
    for (const f of scan.files) {
      if (f.path === ARTIFACTS_DIR || f.path.startsWith(`${ARTIFACTS_DIR}/`)) continue;
      const data = await this.workspaces.readBytes(workspaceId, f.path);
      if (data) entries.push({ path: f.path, data });
    }
    entries.push({ path: JOB_FILE, data: Buffer.from(JSON.stringify({ argv, timeoutMs, memoryMb: this.memoryMb })) });
    await this.aws.storage.put(inKey, tarGz(entries));

    try {
      const [inputUrl, outputUrl] = await Promise.all([this.aws.storage.presignGet(inKey, ttl), this.aws.storage.presignPut(outKey, ttl)]);

      // 2. One task, idempotent on the run id.
      const s = this.aws.settings;
      const request = {
        cluster: s.cluster,
        taskDefinition: s.taskDefinition,
        launchType: 'FARGATE',
        count: 1,
        clientToken: runId,
        startedBy: runId.slice(0, 36),
        networkConfiguration: { awsvpcConfiguration: { subnets: s.subnets, securityGroups: s.securityGroups, assignPublicIp: 'DISABLED' } },
        overrides: { containerOverrides: [{ name: s.containerName, environment: [{ name: 'INPUT_URL', value: inputUrl }, { name: 'OUTPUT_URL', value: outputUrl }] }] },
        tags: [
          { key: 'razekit:workspace', value: workspaceId },
          { key: 'razekit:run', value: runId },
        ],
      };
      let arn: string | undefined;
      for (let attempt = 0; attempt < 3 && !arn; attempt++) {
        try {
          const r = await this.aws.ecs.runTask(request);
          arn = r.tasks?.[0]?.taskArn;
          if (!arn) throw new DevError(ERR.RUNTIME_UNAVAILABLE, `Fargate did not start the build task: ${r.failures?.[0]?.reason ?? 'no reason given'}.`, { httpStatus: 503, retryable: true });
        } catch (e) {
          // The same clientToken makes a retry safe: ECS returns the task a
          // lost answer already started rather than starting another.
          if (e instanceof DevError || attempt === 2) throw e instanceof DevError ? e : new DevError(ERR.RUNTIME_UNAVAILABLE, 'Fargate could not be reached.', { httpStatus: 503, retryable: true });
        }
      }

      // 3. Wait, bounded: the step's own timeout plus time to start.
      const deadline = started + timeoutMs + graceMs;
      let stopped: NonNullable<Awaited<ReturnType<EcsLike['describeTasks']>>['tasks']>[number] | null = null;
      while (Date.now() < deadline) {
        const d = await this.aws.ecs.describeTasks({ cluster: s.cluster, tasks: [arn] });
        const t = d.tasks?.[0];
        if (t?.lastStatus === 'STOPPED') {
          stopped = t;
          break;
        }
        await this.sleep(this.aws.pollMs ?? 3_000);
      }
      if (!stopped) {
        await this.aws.ecs.stopTask({ cluster: s.cluster, task: arn, reason: 'RazeKit DEV step deadline' }).catch(() => undefined);
        return { exitCode: null, signal: 'SIGKILL', timedOut: true, output: '', durationMs: Date.now() - started };
      }
      const exit = stopped.containers?.[0]?.exitCode;
      if (exit !== 0) {
        throw new DevError(
          ERR.RUNTIME_UNAVAILABLE,
          `The build task stopped without a result (${stopped.stopCode ?? 'unknown'}: ${stopped.stoppedReason ?? stopped.containers?.[0]?.reason ?? `exit ${exit}`}).`,
          { httpStatus: 503, retryable: true }
        );
      }

      // 4. The workspace and the result back, untrusted.
      const archive = await this.aws.storage.get(outKey);
      if (!archive) throw new DevError(ERR.RUNTIME_UNAVAILABLE, 'The build task finished but left no result.', { httpStatus: 503, retryable: true });
      let back;
      try {
        back = extractTarGz(archive);
      } catch (e) {
        throw new DevError(ERR.PATH, `The build task returned an unsafe archive: ${(e as Error).message}`, { httpStatus: 422 });
      }
      const resultEntry = back.find((e) => e.path === RESULT_FILE);
      const files = back.filter((e) => e.path !== RESULT_FILE && e.path !== ARTIFACTS_DIR && !e.path.startsWith(`${ARTIFACTS_DIR}/`));
      for (const f of files) safeRelativePath(f.path, { maxDepth: 16 });
      await this.workspaces.restore(workspaceId, files);
      const result = resultEntry ? JSON.parse(resultEntry.data.toString('utf8')) : null;
      if (!result) throw new DevError(ERR.RUNTIME_UNAVAILABLE, 'The build task left no result.', { httpStatus: 503, retryable: true });
      return {
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        signal: result.signal ?? null,
        timedOut: Boolean(result.timedOut),
        output: String(result.output ?? ''),
        durationMs: Date.now() - started,
      };
    } finally {
      await Promise.all([this.aws.storage.remove(inKey).catch(() => undefined), this.aws.storage.remove(outKey).catch(() => undefined)]);
    }
  }
}
