// Assembling RazeKit DEV from configuration — and refusing to assemble a
// weaker version of it in production.
//
// Outside production the defaults favour getting something running: an
// in-memory store when there is no database, the local process runtime, the
// deterministic models when there are no keys, no money held. Every one of
// those is refused in production, and the reason is reported rather than
// swallowed, so an operator turning DEV on sees exactly what is missing:
//
//   store      must be Postgres
//   runtime    must be a sandbox (the local runtime is not isolation)
//   models     must be the real Astra and Fable
//   funding    must be the ledger
//
// Nothing here runs at import time. The engine is built on first use, and only
// when the Development area is switched on.
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { captureError } from '../errors/capture.js';
import { createPrivateArtifactStore } from './artifacts.js';
import { createAnthropicFable } from './engine/anthropic.js';
import { deterministicAstra, deterministicFable } from './engine/deterministic.js';
import { createOpenAIAstra } from './engine/openai.js';
import type { PreflightPricing } from './engine/preflight.js';
import { unavailableAstra, unavailableFable, type ProviderSet } from './engine/providers.js';
import { LedgerFunding, NoFunding, type FundingGate } from './funding.js';
import { ledgerUnitOfWork } from './ledgerUnit.js';
import { Orchestrator, type ArtifactStore, type EngineLimits } from './orchestrator.js';
import { LocalRuntime, SandboxRuntime, type ExecutionRuntime } from './runtime/executor.js';
import { MemoryDevStore } from './store/memory.js';
import { PostgresDevStore } from './store/postgres.js';
import type { DevStore } from './store/types.js';
import { DevWorker } from './worker.js';
import { GitHubApp } from './delivery/github.js';
import { BattleController } from './platform/battle.js';
import { Kit } from './kit/kit.js';
import { createZernio, type SocialProvider } from './kit/zernio.js';
import { DevDepartment, PLATFORM_FAILURES } from './platform/incidents.js';
import { recordTelemetry } from './platform/telemetry.js';
import type { DevTask } from './engine/types.js';
import { FargateRuntime } from './runtime/aws/fargate.js';
import { createAwsClients } from './runtime/aws/clients.js';
import { createEmailNotifier, type DevNotifier } from './notify.js';
import { sendEmail } from '../integrations/email.js';

type DevConfig = typeof config.development;

export interface Readiness {
  ready: boolean;
  production: boolean;
  problems: string[];
  mode: { store: string; runtime: string; models: string; funding: string };
}

export interface DevEngine {
  store: DevStore;
  providers: ProviderSet;
  runtime: ExecutionRuntime;
  funding: FundingGate;
  artifacts: ArtifactStore | null;
  orchestrator: Orchestrator;
  pricing: PreflightPricing;
  limits: EngineLimits;
  readiness: Readiness;
  secrets: string[];
  /** Delivery to GitHub as the RazeKit DEV app; null when the app is not configured. */
  github: GitHubApp | null;
  notifier: DevNotifier | null;
  battle: BattleController;
  devDepartment: DevDepartment;
  kit: Kit;
  settings: {
    currency: string;
    platformFeeBps: number;
    maxTaskBudgetMinor: number;
    leaseMs: number;
    workerCapabilities: string[];
    workerCapacity: number;
    deliveryRepos: string[];
    deliveryDir: string;
    publicVisibleByDefault: boolean;
  };
}

export interface EngineOverrides {
  store?: DevStore;
  providers?: ProviderSet;
  runtime?: ExecutionRuntime;
  funding?: FundingGate;
  artifacts?: ArtifactStore | null;
  production?: boolean;
  now?: () => Date;
  report?: (error: unknown, context: Record<string, unknown>) => void;
  keepWorkspaces?: boolean;
  github?: GitHubApp | null;
  notifier?: DevNotifier | null;
  social?: SocialProvider;
}

export function buildEngine(cfg: DevConfig = config.development, overrides: EngineOverrides = {}): DevEngine {
  const production = overrides.production ?? config.env === 'production';
  const problems: string[] = [];

  // Store
  const storeKind = cfg.store || (cfg.databaseUrl ? 'postgres' : 'memory');
  let store = overrides.store;
  if (!store) {
    if (storeKind === 'postgres' && cfg.databaseUrl) {
      store = new PostgresDevStore({ url: cfg.databaseUrl, schema: cfg.schema });
    } else {
      if (storeKind === 'postgres') problems.push('DEV_STORE is postgres but no DEV_DATABASE_URL or DATABASE_URL is set.');
      store = new MemoryDevStore();
    }
  }
  if (production && store.kind !== 'postgres') problems.push('Production needs the Postgres store; the memory store loses every build on restart.');

  // Runtime
  const workspaceRoot = cfg.workspaceRoot || path.join(os.tmpdir(), 'razekit-dev-workspaces');
  const secrets = [cfg.astra.apiKey, cfg.fable.apiKey, cfg.github.privateKey, cfg.kit.zernioApiKey, cfg.databaseUrl, process.env.DATABASE_URL || '', config.jwtSecret].filter(
    (s) => typeof s === 'string' && s.length >= 8
  );
  const runtime =
    overrides.runtime ??
    (cfg.runtime === 'fargate'
      ? fargateRuntime(cfg, { root: workspaceRoot, secrets, memoryMb: cfg.buildMemoryMb })
      : cfg.runtime === 'sandbox'
      ? new SandboxRuntime({ root: workspaceRoot })
      : new LocalRuntime({ root: workspaceRoot, secrets, memoryMb: cfg.buildMemoryMb }));
  if (!runtime.status.available) problems.push(runtime.status.reason || 'The build runtime is not available.');
  if (production && runtime.kind === 'local') {
    problems.push('Production refuses the local process runtime: it is not isolation. A sandboxed runtime must be attached first.');
  }

  // Models
  const providers = overrides.providers ?? buildProviders(cfg, production);
  if (providers.mode !== 'real') {
    if (production) problems.push('Production needs the real Astra and Fable: set ASTRA_API_KEY and FABLE_API_KEY.');
    if (providers.mode === 'unavailable') {
      problems.push(...[providers.astra.info.reason, providers.fable.info.reason].filter((r): r is string => Boolean(r)));
    }
  }

  // Money
  const fundingMode = cfg.funding || (production ? 'ledger' : 'none');
  const funding = overrides.funding ?? (fundingMode === 'ledger' ? new LedgerFunding({ unitOfWork: ledgerUnitOfWork, currency: cfg.currency }) : new NoFunding());
  if (production && funding.mode !== 'ledger') problems.push('Production builds must be funded: set DEV_FUNDING=ledger.');

  const artifacts = overrides.artifacts !== undefined ? overrides.artifacts : createPrivateArtifactStore();

  const limits: EngineLimits = {
    maxImplementAttempts: cfg.maxImplementAttempts,
    maxTransientRetries: 5,
    maxInvalidOutputs: 3,
    leaseMs: cfg.leaseMs,
  };

  // Platform self-improvement: Battle Mode and the Dev Department read what
  // builds leave behind, in DEV's own store. Neither can spend a customer's
  // budget, and neither can change code by itself.
  const battle = new BattleController({ store, astra: () => providers.astra, now: overrides.now });
  let devDepartment: DevDepartment;
  const platformBudgetLeft = async () => (await battle.settings()).monthlyBudgetMinor - (await battle.spentThisMonth()) - (await devDepartment.spentThisMonth());
  devDepartment = new DevDepartment({ store, astra: () => providers.astra, secrets, platformBudgetLeft, now: overrides.now });
  const baseReport = overrides.report ?? ((error: unknown, context: Record<string, unknown>) => void captureError(null, { error, service: 'dev', severity: 'error', context }));
  const report = (error: unknown, context: Record<string, unknown>) => {
    baseReport(error, context);
    // Every unexpected error is also an incident, fingerprinted and counted.
    void devDepartment
      .intake({ source: 'error', code: String((error as any)?.code ?? 'DEV_UNEXPECTED'), message: `${String(context?.where ?? 'dev')}: ${(error as Error)?.message ?? String(error)}`, taskId: (context?.taskId as string) ?? null })
      .catch(() => undefined);
  };
  const onSettled = async (task: DevTask) => {
    await recordTelemetry(store!, task, { runtime: runtime.kind, models: providers.mode });
    if (task.state === 'failed' && task.failure && PLATFORM_FAILURES.has(task.failure.code)) {
      await devDepartment.intake({ source: 'build-failure', code: task.failure.code, message: task.failure.message, taskId: task.id });
    }
  };
  // Email through the platform's existing integration (Resend in production;
  // the console driver in development just logs). Tests pass their own.
  const notifier =
    overrides.notifier !== undefined
      ? overrides.notifier
      : createEmailNotifier({ store, send: (m) => sendEmail({ to: m.to, subject: m.subject, body: m.body }), webBaseUrl: config.webBaseUrl, now: overrides.now, report });
  const orchestrator = new Orchestrator({
    notifier,
    onSettled,
    store,
    providers,
    runtime,
    funding,
    artifacts,
    secrets,
    limits,
    now: overrides.now,
    keepWorkspaces: overrides.keepWorkspaces ?? cfg.keepWorkspaces,
    report,
  });

  return {
    store,
    providers,
    runtime,
    funding,
    artifacts,
    orchestrator,
    pricing: {
      astra: providers.astra.info.mode === 'real' ? providers.astra.info.price : { inputMinorPerMTok: cfg.astra.inputMinorPerMTok, outputMinorPerMTok: cfg.astra.outputMinorPerMTok },
      fable: providers.fable.info.mode === 'real' ? providers.fable.info.price : { inputMinorPerMTok: cfg.fable.inputMinorPerMTok, outputMinorPerMTok: cfg.fable.outputMinorPerMTok },
      currency: cfg.currency,
    },
    limits,
    readiness: {
      ready: problems.length === 0,
      production,
      problems,
      mode: { store: store.kind, runtime: runtime.kind, models: providers.mode, funding: funding.mode },
    },
    secrets,
    notifier,
    battle,
    devDepartment,
    kit: new Kit({ store, provider: overrides.social ?? createZernio({ apiKey: cfg.kit.zernioApiKey, baseUrl: cfg.kit.zernioBaseUrl }), now: overrides.now }),
    github: overrides.github !== undefined ? overrides.github : cfg.github.appId && cfg.github.privateKey ? new GitHubApp({ appId: cfg.github.appId, privateKey: cfg.github.privateKey, apiBase: cfg.github.apiBase }) : null,
    settings: {
      currency: cfg.currency,
      platformFeeBps: cfg.platformFeeBps,
      maxTaskBudgetMinor: cfg.maxTaskBudgetMinor,
      leaseMs: cfg.leaseMs,
      workerCapabilities: cfg.workerCapabilities,
      workerCapacity: cfg.workerCapacity,
      deliveryRepos: cfg.github.deliveryRepos,
      deliveryDir: cfg.github.deliveryDir,
      publicVisibleByDefault: cfg.publicVisibility === 'visible',
    },
  };
}

/**
 * The Fargate runtime, with its AWS clients created on first use (the SDK is
 * optional and loaded lazily, so a deployment without it still boots and
 * reports the runtime unavailable rather than crashing).
 */
function fargateRuntime(cfg: DevConfig, opts: { root: string; secrets: string[]; memoryMb: number }): ExecutionRuntime {
  if (!cfg.aws.bucket) return new SandboxRuntime({ root: opts.root, reason: 'The Fargate runtime needs DEV_AWS_BUCKET.' });
  let clients: ReturnType<typeof createAwsClients> | null = null;
  const lazy = <K extends 'ecs' | 'storage'>(k: K) =>
    new Proxy({} as any, {
      get: (_t, method) => async (...args: unknown[]) => {
        clients ??= createAwsClients({ region: cfg.aws.region, bucket: cfg.aws.bucket });
        const c = (await clients)[k] as any;
        return c[method](...args);
      },
    });
  return new FargateRuntime(opts, {
    ecs: lazy('ecs'),
    storage: lazy('storage'),
    settings: {
      cluster: cfg.aws.cluster,
      taskDefinition: cfg.aws.taskDefinition,
      containerName: cfg.aws.containerName,
      subnets: cfg.aws.subnets,
      securityGroups: cfg.aws.securityGroups,
      prefix: cfg.aws.prefix,
    },
  });
}

export function buildProviders(cfg: DevConfig, production: boolean): ProviderSet {
  const hasKeys = Boolean(cfg.astra.apiKey && cfg.fable.apiKey);
  const mode = cfg.modelMode;

  if (mode === 'real' || (mode === 'auto' && hasKeys)) {
    // Powerful models only: a model outside the approved list is not a
    // configuration to run with, it is a provider that is unavailable.
    const astraBlocked = !cfg.astra.allowedModels.includes(cfg.astra.model);
    const fableBlocked = !cfg.fable.allowedModels.includes(cfg.fable.model);
    const astra = astraBlocked
      ? unavailableAstra(`${cfg.astra.model} is not on the approved Astra model list.`)
      : cfg.astra.apiKey
      ? createOpenAIAstra({
          apiKey: cfg.astra.apiKey,
          model: cfg.astra.model,
          baseUrl: cfg.astra.baseUrl,
          price: { inputMinorPerMTok: cfg.astra.inputMinorPerMTok, outputMinorPerMTok: cfg.astra.outputMinorPerMTok },
          maxOutputTokens: { plan: cfg.astra.maxPlanTokens, review: cfg.astra.maxReviewTokens },
          timeoutMs: cfg.providerTimeoutMs,
        })
      : unavailableAstra('the Astra API key is not configured.');
    const fable = fableBlocked
      ? unavailableFable(`${cfg.fable.model} is not on the approved Fable model list.`)
      : cfg.fable.apiKey
      ? createAnthropicFable({
          apiKey: cfg.fable.apiKey,
          model: cfg.fable.model,
          price: { inputMinorPerMTok: cfg.fable.inputMinorPerMTok, outputMinorPerMTok: cfg.fable.outputMinorPerMTok },
          maxOutputTokens: cfg.fable.maxOutputTokens,
          effort: cfg.fable.effort,
          timeoutMs: cfg.providerTimeoutMs,
          allowedModels: cfg.fable.allowedModels,
          refusalFallback: cfg.fable.refusalFallback,
        })
      : unavailableFable('the Fable API key is not configured.');
    // `real` never quietly becomes deterministic: a missing key is a missing
    // key, reported as such.
    return { astra, fable, mode: astra.info.available && fable.info.available ? 'real' : 'unavailable' };
  }

  if (production) {
    return {
      astra: unavailableAstra('the Astra API key is not configured.'),
      fable: unavailableFable('the Fable API key is not configured.'),
      mode: 'unavailable',
    };
  }
  return { astra: deterministicAstra(), fable: deterministicFable(), mode: 'deterministic' };
}

// ── The process-wide engine ───────────────────────────────────────────────────

let enginePromise: Promise<DevEngine> | null = null;
let worker: DevWorker | null = null;

/** The engine, built and initialised once, on first use. */
export function getEngine(): Promise<DevEngine> {
  enginePromise ??= (async () => {
    const engine = buildEngine();
    await engine.store.init();
    return engine;
  })().catch((e) => {
    enginePromise = null;
    throw e;
  });
  return enginePromise;
}

/**
 * Called once from the API entry point when the Development area is on.
 * Initialises the store, and starts an in-process worker only where that is
 * allowed (never in production).
 */
export async function startDevelopment(log: (m: string) => void = console.log) {
  try {
    const engine = await getEngine();
    const r = engine.readiness;
    log(`   Development: ${r.ready ? 'ready' : 'NOT READY'} (store ${r.mode.store}, runtime ${r.mode.runtime}, models ${r.mode.models}, funding ${r.mode.funding})`);
    for (const p of r.problems) log(`     - ${p}`);
    if (config.development.workerInProcess) {
      if (r.production) {
        log('   Development: DEV_WORKER_INPROCESS is ignored in production; run the dev worker service.');
      } else if (r.ready) {
        worker = startWorker(engine, log);
      }
    }
  } catch (e) {
    log(`   Development: failed to start — ${(e as Error).message.split('\n')[0]}`);
    void captureError(null, { error: e, service: 'dev', severity: 'error', context: { where: 'startDevelopment' } });
  }
}

export function startWorker(engine: DevEngine, log: (m: string) => void = console.log): DevWorker {
  const w = new DevWorker({
    store: engine.store,
    orchestrator: engine.orchestrator,
    capabilities: engine.settings.workerCapabilities,
    capacity: engine.settings.workerCapacity,
    leaseMs: engine.settings.leaseMs,
    log,
    // Battle Mode's pass: once a minute across the whole fleet (claimOnce),
    // and a no-op while an administrator has it off.
    periodic: { everyMs: 60_000, run: () => engine.battle.tick() },
  });
  void w.start();
  return w;
}

export async function stopDevelopment() {
  await worker?.stop();
  worker = null;
  if (enginePromise) (await enginePromise.catch(() => null))?.store.close();
  enginePromise = null;
}
