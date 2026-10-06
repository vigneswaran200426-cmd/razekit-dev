// The DEV control plane: everything the API does on a user's behalf.
//
// Routes stay thin; the rules live here, and every method takes the caller as
// its first argument so tenancy is decided in one place. A build belonging to
// another account is "not found" — never "forbidden", which would confirm it
// exists.
//
// The API never runs a build. It records requests, moves money through the
// funding gate, and reads projections. Workers do the building.
import { randomUUID } from 'node:crypto';
import { agentDefinition } from './engine/agents.js';
import { chooseEngine, detectEngines, type EngineStatus } from './konami/engines.js';
import { budgetSnapshot, classifyChange, parseCommand } from './engine/classify.js';
import { DevError, ERR, notFound, validation } from './engine/errors.js';
import { analyze, iterationCostMinor, MAX_TITLE_CHARS, parseRequest, parseTaskType } from './engine/preflight.js';
import { toMajor, toMinor } from './engine/pricing.js';
import { isTerminal, transition } from './engine/states.js';
import { buildTask, tenantIdFor } from './engine/task.js';
import { TASK_STATE as S, type DevChange, type DevTask } from './engine/types.js';
import { InsufficientFunds, recordVerifiedPurchase } from './funding.js';
import { ledgerUnitOfWork } from './ledgerUnit.js';
import type { DevEngine } from './bootstrap.js';
import { acceptanceView, changeView, dashboard, DECISION_PREFIX, eventView, taskDetail, taskSummary } from './projection.js';
import { CONTROL_EXECUTION, type ExecutionControl } from './worker.js';
import type { LedgerUnitOfWork } from './funding.js';

export interface Caller {
  id: string;
  role?: string;
  /** From the signed-in session only. */
  email?: string | null;
}

const MAX_CRITERIA = 20;
const MAX_CRITERION_CHARS = 300;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
const ARTIFACT_URL_TTL_SECONDS = 600;

export class DevService {
  constructor(
    private engine: DevEngine,
    private opts: { now?: () => Date; unitOfWork?: LedgerUnitOfWork } = {}
  ) {}

  private iso() {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  private get store() {
    return this.engine.store;
  }

  private assertReady() {
    const r = this.engine.readiness;
    if (!r.ready) {
      throw new DevError(ERR.NOT_CONFIGURED, 'Development is not available on this deployment yet.', { httpStatus: 503 });
    }
  }

  private async own(caller: Caller, id: string): Promise<DevTask> {
    const task = await this.store.getTask(String(id), { tenantId: tenantIdFor(caller) });
    if (!task) throw notFound();
    return task;
  }

  // ── Reading ─────────────────────────────────────────────────────────────────

  status(caller: Caller) {
    const r = this.engine.readiness;
    return {
      configured: r.ready,
      // Operators see why it is not ready; everyone else just sees that it is not.
      ...(caller.role === 'admin' ? { readiness: r } : {}),
      models: r.mode.models,
      currency: this.engine.settings.currency,
      maxBudget: toMajor(this.engine.settings.maxTaskBudgetMinor),
    };
  }

  /**
   * Whether the DEV entry is shown on the public site. Visibility is about
   * being found, not about existing: hidden, DEV and every build stay as they
   * are, and administrators still see the entry.
   */
  async visibility(): Promise<{ visible: boolean; changedAt: string | null }> {
    // Read on every public page load, so briefly cached; another instance
    // sees a change within VISIBILITY_CACHE_MS.
    const now = Date.now();
    if (this.visibilityCache && this.visibilityCache.until > now) return this.visibilityCache.value;
    const stored = await this.store.getControl<VisibilityControl>(CONTROL_VISIBILITY).catch(() => null);
    const value = stored ? { visible: stored.visible, changedAt: stored.changedAt } : { visible: this.engine.settings.publicVisibleByDefault, changedAt: null };
    this.visibilityCache = { value, until: now + VISIBILITY_CACHE_MS };
    return value;
  }
  private visibilityCache: { value: { visible: boolean; changedAt: string | null }; until: number } | null = null;

  /** What the navigation should offer this caller. */
  async entry(caller: Caller) {
    const { visible } = await this.visibility();
    const ready = this.engine.readiness.ready;
    return { visible, showEntry: ready && (visible || caller.role === 'admin') };
  }

  async setVisibility(caller: Caller, visible: unknown, reason: unknown) {
    if (typeof visible !== 'boolean') throw validation('Say whether DEV should be visible (true or false).');
    const control: VisibilityControl = {
      visible,
      changedBy: caller.id,
      changedAt: this.iso(),
      reason: typeof reason === 'string' ? reason.trim().slice(0, 500) : '',
    };
    await this.store.setControl(CONTROL_VISIBILITY, control);
    const history = (await this.store.getControl<VisibilityControl[]>(CONTROL_VISIBILITY_LOG).catch(() => null)) ?? [];
    await this.store.setControl(CONTROL_VISIBILITY_LOG, [control, ...history].slice(0, 100));
    this.visibilityCache = null;
    return { visible, changedAt: control.changedAt };
  }

  /** Game engines and whether each can build here. Probed, never assumed. */
  async engines() {
    this.engineCache ??= detectEngines();
    return { engines: await this.engineCache };
  }
  private engineCache: Promise<EngineStatus[]> | null = null;

  analyze(input: any) {
    return analyze(
      { taskType: input?.taskType, title: input?.title, originalRequest: input?.originalRequest },
      this.engine.pricing,
      this.engine.runtime.availability()
    );
  }

  async list(caller: Caller) {
    return (await this.store.listTasks(tenantIdFor(caller), { limit: 100 })).map(taskSummary);
  }

  async get(caller: Caller, id: string) {
    return taskDetail(await this.own(caller, id));
  }

  async dashboard(caller: Caller, id: string) {
    const task = await this.own(caller, id);
    const [events, changes] = await Promise.all([
      this.store.listEvents(task.id, { kinds: ['update', 'chat'], limit: 200 }),
      this.store.listChanges(task.id),
    ]);
    return dashboard(task, { events, changes });
  }

  async events(caller: Caller, id: string) {
    const task = await this.own(caller, id);
    return (await this.store.listEvents(task.id, { kinds: ['update'], limit: 200 })).map(eventView);
  }

  async acceptance(caller: Caller, id: string) {
    return acceptanceView(await this.own(caller, id));
  }

  async balances(caller: Caller) {
    const b = await this.engine.funding.balances(caller.id);
    return b
      ? {
          mode: 'ledger',
          // What a new build can draw on, credit included.
          available: toMajor(b.spendableMinor),
          purchased: toMajor(b.availableMinor),
          reserved: toMajor(b.reservedMinor),
          consumed: toMajor(b.consumedMinor),
          credit: toMajor(b.creditMinor),
          currency: b.currency,
        }
      : { mode: 'none', currency: this.engine.settings.currency };
  }

  async artifact(caller: Caller, id: string) {
    const task = await this.own(caller, id);
    if (task.state !== S.COMPLETED || !task.artifact) throw new DevError(ERR.NOT_FOUND, 'This build has no finished artifact yet.', { httpStatus: 404 });
    if (!task.artifact.storageUri || !this.engine.artifacts) {
      throw new DevError(ERR.NOT_FOUND, 'The artifact was not kept in storage on this deployment.', { httpStatus: 404 });
    }
    const url = await this.engine.artifacts.signedUrl(task.artifact.storageUri, ARTIFACT_URL_TTL_SECONDS);
    return {
      url,
      expiresAt: new Date(Date.now() + ARTIFACT_URL_TTL_SECONDS * 1000).toISOString(),
      bytes: task.artifact.bytes,
      sha256: task.artifact.sha256,
      filename: `${task.id}.tar.gz`,
    };
  }

  // ── Starting a build ────────────────────────────────────────────────────────

  async create(caller: Caller, input: any, opts: { idempotencyKey?: string | null } = {}) {
    this.assertReady();
    const taskType = parseTaskType(input?.taskType);
    if (taskType === 'game' && input?.engine !== undefined) {
      const choice = chooseEngine(input.engine, (await this.engines()).engines);
      if ('refused' in choice) throw validation(choice.refused);
    }
    const originalRequest = parseRequest(input?.originalRequest);
    const title = (typeof input?.title === 'string' ? input.title.trim() : '').slice(0, MAX_TITLE_CHARS) || 'Untitled build';

    // Consent is explicit and specific. A build without it is refused, not
    // defaulted: this is someone agreeing to let software write and run code
    // and spend their money.
    if (input?.acceptAutonomousExecution !== true) {
      throw new DevError(ERR.AUTHORIZATION_REQUIRED, 'Autonomous building has to be explicitly authorised before a build can start.', { httpStatus: 400 });
    }

    const maxBudget = Number(input?.maxBudget);
    const maxBudgetMinor = toMinor(maxBudget);
    if (!Number.isFinite(maxBudget) || maxBudgetMinor < 100) throw validation('Set a maximum budget of at least 1.');
    if (maxBudgetMinor > this.engine.settings.maxTaskBudgetMinor) {
      throw validation(`The maximum budget for one build is ${toMajor(this.engine.settings.maxTaskBudgetMinor)}.`);
    }

    const rawCriteria = input?.acceptanceCriteria ?? [];
    if (!Array.isArray(rawCriteria) || rawCriteria.length > MAX_CRITERIA) throw validation(`Give at most ${MAX_CRITERIA} acceptance criteria.`);
    const userCriteria = rawCriteria.map((c: unknown) => {
      const text = typeof c === 'string' ? c.trim() : '';
      if (!text || text.length > MAX_CRITERION_CHARS) throw validation(`Each acceptance criterion must be 1–${MAX_CRITERION_CHARS} characters.`);
      return text;
    });

    const creationKey = opts.idempotencyKey && IDEMPOTENCY_KEY.test(opts.idempotencyKey) ? opts.idempotencyKey : null;
    const funding = this.engine.funding;

    // Checked before anything is created, so the common "not enough budget"
    // case leaves nothing behind. The reservation below is what actually
    // decides; this only avoids creating a build that cannot start.
    if (funding.mode === 'ledger') {
      const b = await funding.balances(caller.id);
      if (b && b.spendableMinor < maxBudgetMinor) throw new InsufficientFunds(maxBudgetMinor, b.spendableMinor);
    }

    const at = this.iso();
    const preflight = analyze({ taskType, title, originalRequest }, this.engine.pricing, this.engine.runtime.availability());
    const built = buildTask({
      userId: caller.id,
      taskType,
      title,
      originalRequest,
      maxBudgetMinor,
      currency: this.engine.settings.currency,
      preflight,
      userCriteria,
      fundingMode: funding.mode,
      at,
    });
    // An unfunded build is given a recovery time: if this request dies before
    // the reservation below completes, a worker finishes the job.
    const withOwner = { ...built, notifyEmail: typeof caller.email === 'string' && caller.email.includes('@') ? caller.email : null };
    const candidate = funding.mode === 'ledger' ? { ...withOwner, nextRunAt: new Date(Date.parse(at) + 120_000).toISOString() } : withOwner;
    const { task: inserted, created } = await this.store.insertTask(candidate, { creationKey });
    if (!created) return { task: taskDetail(inserted), agent: { agentType: inserted.agentType, workspaceId: inserted.workspaceId }, replayed: true };

    let task = inserted;
    if (funding.mode === 'ledger') {
      try {
        const reservation = await funding.secure(task);
        task = await this.store.saveTask(
          transition({ ...task, funding: { ...task.funding, reservations: reservation ? [reservation] : [] } }, S.QUEUED, { at: this.iso() }),
          { expectedRevision: task.revision }
        );
      } catch (e) {
        if (e instanceof InsufficientFunds) {
          await this.store.saveTask(transition(task, S.FAILED, { at: this.iso(), failure: { code: e.code, message: e.message } }), { expectedRevision: task.revision }).catch(() => undefined);
        }
        throw e;
      }
    }

    await this.event(task, { kind: 'audit', title: 'Authorised', message: `${task.authorization.statement} (by ${caller.id}, budget ${task.maxBudgetMinor} ${task.currency})` });
    await this.event(task, { kind: 'update', status: 'WORKING', title: 'Build requested', message: 'Waiting for a builder to pick it up.' });
    return { task: taskDetail(task), agent: { agentType: task.agentType, workspaceId: task.workspaceId } };
  }

  async update(caller: Caller, id: string, patch: any) {
    const task = await this.own(caller, id);
    const keys = Object.keys(patch ?? {});
    if (keys.some((k) => k !== 'title')) throw validation('Only the title of a build can be edited. Ask for other changes in the conversation.');
    const title = typeof patch.title === 'string' ? patch.title.trim().slice(0, MAX_TITLE_CHARS) : '';
    if (!title) throw validation('A title cannot be empty.');
    const saved = await this.mutateFresh(task.id, (fresh) => ({ ...fresh, title, updatedAt: this.iso() }));
    return taskDetail(saved);
  }

  // ── Talking to a running build ──────────────────────────────────────────────

  async command(caller: Caller, id: string, content: unknown) {
    const text = parseCommand(content);
    const task = await this.own(caller, id);
    if (isTerminal(task.state)) throw new DevError(ERR.STATE, 'This build has finished. Start a new one to change it.', { httpStatus: 409 });

    const { classification, reason } = classifyChange(text, task.taskType);
    const projected = iterationCostMinor(task.preflight.complexity, {
      astra: this.engine.providers.astra.info.price,
      fable: this.engine.providers.fable.info.price,
      currency: task.currency,
    });
    const change: DevChange = await this.store.insertChange({
      id: `chg_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      taskId: task.id,
      tenantId: task.tenantId,
      content: text,
      classification,
      status: classification === 'refinement' ? 'applied' : 'pending',
      reason,
      budgetSnapshot: budgetSnapshot(task, projected),
      createdAt: this.iso(),
      resolvedAt: null,
    });

    await this.event(task, { kind: 'chat', role: 'user', title: 'You', message: text });
    await this.event(task, {
      kind: 'chat',
      role: classification === 'refinement' ? 'assistant' : 'system',
      title: classification === 'refinement' ? 'Builder' : 'RazeKit',
      message: classification === 'refinement' ? "Got it. That goes into the next version." : `This needs your approval first. ${reason}`,
    });
    return { change: changeView(change), classification };
  }

  async approve(caller: Caller, id: string, changeId: string, body: any) {
    let task = await this.own(caller, id);
    const change = await this.store.getChange(task.id, String(changeId));
    if (!change) throw notFound('Change');
    if (change.status !== 'pending') throw new DevError(ERR.STATE, 'This has already been decided.', { httpStatus: 409 });
    if (change.classification === 'out_of_scope') {
      throw new DevError(ERR.STATE, 'That is a different build. Decline this and start a new build for it.', { httpStatus: 409 });
    }

    // Money first: if approving needs a higher ceiling, it is raised — and on
    // the ledger, reserved — before anything else happens. It is never raised
    // implicitly by approving.
    const requestedMax = body?.maxBudget == null ? null : toMinor(Number(body.maxBudget));
    const needed = change.budgetSnapshot.withinBudget ? task.maxBudgetMinor : Math.max(task.maxBudgetMinor, change.budgetSnapshot.projectedSpendMinor);
    if (!change.budgetSnapshot.withinBudget && (requestedMax === null || !(requestedMax >= needed))) {
      throw validation(`Approving this needs a limit of at least ${toMajor(needed)}.`);
    }
    if (requestedMax !== null && requestedMax > task.maxBudgetMinor) {
      if (requestedMax > this.engine.settings.maxTaskBudgetMinor) {
        throw validation(`The maximum budget for one build is ${toMajor(this.engine.settings.maxTaskBudgetMinor)}.`);
      }
      task = await this.raiseBudget(task, requestedMax, change.id);
    }

    const resolved = await this.store.resolveChange(task.id, change.id, 'approved', this.iso());
    if (!resolved) throw new DevError(ERR.STATE, 'This has already been decided.', { httpStatus: 409 });

    // If the build stopped to ask this question, answering it resumes it.
    if (task.state === S.WAITING_USER && task.decision?.changeId === change.id && task.resumeState) {
      task = await this.store.saveTask(transition(task, task.resumeState, { at: this.iso() }), { expectedRevision: task.revision });
      await this.event(task, { kind: 'update', status: 'WORKING', title: 'Carrying on', message: 'Thanks. The build is continuing.' });
    }
    await this.event(task, { kind: 'chat', role: 'system', title: 'RazeKit', message: `Approved: ${display(change.content)}` });
    return { change: changeView(resolved), task: taskSummary(task) };
  }

  async deny(caller: Caller, id: string, changeId: string, reason: unknown) {
    let task = await this.own(caller, id);
    const resolved = await this.store.resolveChange(task.id, String(changeId), 'denied', this.iso());
    if (!resolved) {
      if (!(await this.store.getChange(task.id, String(changeId)))) throw notFound('Change');
      throw new DevError(ERR.STATE, 'This has already been decided.', { httpStatus: 409 });
    }
    await this.event(task, { kind: 'chat', role: 'system', title: 'RazeKit', message: `Declined: ${display(resolved.content)}` });

    // Declining the question a stopped build asked means the build stops.
    if (task.state === S.WAITING_USER && task.decision?.changeId === resolved.id) {
      task = await this.finish(task, 'You chose to stop here.');
    }
    return { change: changeView(resolved), task: taskSummary(task), note: typeof reason === 'string' ? reason.slice(0, 200) : undefined };
  }

  async cancel(caller: Caller, id: string) {
    const task = await this.own(caller, id);
    if (isTerminal(task.state)) throw new DevError(ERR.STATE, 'This build has already finished.', { httpStatus: 409 });
    const stopped = await this.finish(task, 'Stopped at your request.');
    return taskSummary(stopped);
  }

  /**
   * Delivers a finished, verified build to GitHub as a draft pull request on a
   * new razekit-dev/ branch. The owner asking is the authorization; the
   * repository must be one the operator allows. Safe to repeat: a second call
   * returns the delivery the first one made.
   */
  async deliver(caller: Caller, id: string, input: any) {
    const task = await this.own(caller, id);
    if (task.state !== S.COMPLETED) throw new DevError(ERR.STATE, 'Only a finished, verified build can be delivered.', { httpStatus: 409 });
    const github = this.engine.github;
    if (!github) throw new DevError(ERR.NOT_CONFIGURED, 'Delivery to GitHub is not set up on this deployment.', { httpStatus: 503 });
    const repository = String(input?.repository ?? '').trim();
    const allowed = this.engine.settings.deliveryRepos.map((r) => r.toLowerCase());
    if (!allowed.includes(repository.toLowerCase())) {
      throw validation('That repository is not open for delivery on this deployment.');
    }
    const plan = task.blackboard.executionPlan;
    if (!plan) throw new DevError(ERR.STATE, 'This build has no source to deliver.', { httpStatus: 409 });
    const [owner, repo] = repository.split('/');
    const dir = `${this.engine.settings.deliveryDir}/${task.id}`;
    const provided = this.engine.runtime.providedFiles(agentDefinition(task.agentType));
    const files = [...plan.files, ...provided.filter((p) => !plan.files.some((f) => f.path === p.path))].map((f) => ({
      path: `${dir}/${f.path}`,
      content: f.content,
    }));
    const result = await github.deliver({
      owner,
      repo,
      branch: `razekit-dev/${task.id}`,
      baseBranch: typeof input?.baseBranch === 'string' && input.baseBranch.trim() ? input.baseBranch.trim() : null,
      files,
      commitMessage: `RazeKit DEV: ${task.title}\n\nVerified build ${task.id}.`,
      title: `RazeKit DEV: ${task.title}`.slice(0, 200),
      body: [
        `Delivered by RazeKit DEV from build \`${task.id}\`, after it passed verification.`,
        '',
        `- Files: ${files.length}, under \`${dir}/\``,
        `- Verification: ${task.verification.status}`,
        task.artifact ? `- Packaged artifact sha256: \`${task.artifact.sha256}\`` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    const record = {
      repository: result.repository,
      branch: result.branch,
      baseBranch: result.baseBranch,
      commitSha: result.commitSha,
      pullRequest: result.pullRequest,
      deliveredAt: task.delivery?.deliveredAt ?? this.iso(),
    };
    let first = false;
    const saved = await this.mutateFresh(task.id, (fresh) => {
      if (fresh.delivery?.pullRequest.url === record.pullRequest.url) return null;
      first = true;
      return { ...fresh, delivery: record, updatedAt: this.iso() };
    });
    if (first) {
      await this.engine.notifier?.notify(saved, 'delivered');
      await this.event(saved, { kind: 'update', status: 'COMPLETED', title: 'Delivered to GitHub', message: `Draft pull request #${record.pullRequest.number} in ${record.repository}.` });
    }
    return { ...record, replayed: !first };
  }

  // ── Operators ───────────────────────────────────────────────────────────────

  /** Kit, the content workspace. Its own rules live in kit/kit.ts. */
  get kit() {
    return this.engine.kit;
  }

  /** Battle Mode: settings, baselines, detected candidates, battles. */
  async battleOverview() {
    const [overview, benchmarks] = await Promise.all([
      this.engine.battle.overview(),
      this.store.listRecords('benchmark', { limit: 10 }).then((rs) => rs.map((r) => r.data)),
    ]);
    return { ...overview, benchmarks };
  }

  async setBattleSettings(caller: Caller, input: any) {
    try {
      return await this.engine.battle.setSettings(caller.id, {
        mode: input?.mode,
        monthlyBudgetMinor: input?.monthlyBudget !== undefined ? toMinor(input.monthlyBudget) : undefined,
        perBattleBudgetMinor: input?.perBattleBudget !== undefined ? toMinor(input.perBattleBudget) : undefined,
        maxCycles: input?.maxCycles,
        cooldownMinutes: input?.cooldownMinutes,
      });
    } catch (e) {
      throw validation((e as Error).message);
    }
  }

  async decideBattle(caller: Caller, id: string, input: any) {
    try {
      return await this.engine.battle.decide(caller.id, id, input?.action, String(input?.note ?? ''), input?.pullRequestUrl);
    } catch (e) {
      throw validation((e as Error).message);
    }
  }

  /** Runs the benchmark suite now (real builds on the deterministic models). */
  async runBenchmark(caller: Caller) {
    const { runBenchmark } = await import('./platform/benchmark.js');
    return runBenchmark(this.store, caller.id);
  }

  async incidents() {
    return { incidents: await this.engine.devDepartment.list() };
  }

  async fileIncident(caller: Caller, input: any) {
    const title = String(input?.title ?? '').trim().slice(0, 160);
    const detail = String(input?.detail ?? '').trim().slice(0, 2000);
    if (!title) throw validation('An incident needs a title.');
    return this.engine.devDepartment.intake({ source: 'operator', code: 'OPERATOR_REPORT', title, message: `${title}\n${detail}`.trim() });
  }

  async actOnIncident(caller: Caller, fingerprint: string, input: any) {
    try {
      if (input?.action === 'analyse') return await this.engine.devDepartment.analyse(caller.id, fingerprint);
      return await this.engine.devDepartment.act(caller.id, fingerprint, input?.action, String(input?.note ?? ''), input?.pullRequestUrl);
    } catch (e) {
      throw validation((e as Error).message);
    }
  }

  async health() {
    const [store, queue, workers, control] = await Promise.all([
      this.store.health(),
      this.store.queueStats().catch(() => null),
      this.store.listWorkers().catch(() => []),
      this.store.getControl<ExecutionControl>(CONTROL_EXECUTION).catch(() => null),
    ]);
    return {
      readiness: this.engine.readiness,
      store,
      queue,
      workers,
      execution: control ?? { paused: false },
      visibility: await this.visibility(),
      providers: {
        astra: { ...this.engine.providers.astra.info, price: undefined },
        fable: { ...this.engine.providers.fable.info, price: undefined },
      },
      runtime: { kind: this.engine.runtime.kind, ...this.engine.runtime.status },
      funding: this.engine.funding.mode,
    };
  }

  /** The emergency stop: workers stop claiming new work. Builds in flight finish their current step. */
  async setPaused(admin: Caller, paused: boolean, reason: unknown) {
    const value: ExecutionControl = {
      paused: Boolean(paused),
      reason: typeof reason === 'string' ? reason.slice(0, 300) : undefined,
      by: admin.id,
      at: this.iso(),
    };
    await this.store.setControl(CONTROL_EXECUTION, value);
    return value;
  }

  /** Records development budget an administrator has verified was paid. */
  async recordPurchase(admin: Caller, body: any) {
    if (this.engine.funding.mode !== 'ledger') {
      throw new DevError(ERR.NOT_CONFIGURED, 'This deployment does not hold development budget, so purchases cannot be recorded here.', { httpStatus: 409 });
    }
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const paymentReference = typeof body?.paymentReference === 'string' ? body.paymentReference.trim() : '';
    const budgetMinor = toMinor(Number(body?.budget));
    if (!userId) throw validation('Which account paid?');
    if (!/^[A-Za-z0-9_.:/-]{4,100}$/.test(paymentReference)) throw validation('Give the verified payment reference (4–100 characters).');
    if (!(budgetMinor >= 100)) throw validation('The budget must be at least 1.');
    const result = await recordVerifiedPurchase(this.opts.unitOfWork ?? ledgerUnitOfWork, {
      userId,
      budgetMinor,
      paymentReference,
      adminId: admin.id,
      currency: this.engine.settings.currency,
      platformFeeBps: this.engine.settings.platformFeeBps,
    });
    return {
      replayed: result.replayed,
      budget: toMajor(result.quote.subtotalMinor),
      platformFee: toMajor(result.quote.platformFeeMinor),
      total: toMajor(result.quote.totalMinor),
      currency: this.engine.settings.currency,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async raiseBudget(task: DevTask, newMaxMinor: number, key: string): Promise<DevTask> {
    const delta = newMaxMinor - task.maxBudgetMinor;
    const reservation = await this.engine.funding.secureIncrease(task, delta, key);
    await this.store.raiseBudget(task.id, newMaxMinor);
    if (!reservation) return (await this.store.getTask(task.id))!;
    // The money is already reserved on the ledger, so recording it on the
    // build must not be lost to a worker saving at the same moment: a
    // reservation the build does not know about is never settled, and the
    // money would stay reserved for good. Retried until it sticks.
    return this.mutateFresh(task.id, (fresh) =>
      fresh.funding.reservations.some((r) => r.id === reservation.id)
        ? null
        : { ...fresh, funding: { ...fresh.funding, reservations: [...fresh.funding.reservations, reservation] }, updatedAt: this.iso() }
    );
  }

  /**
   * Applies a change to the latest version of a build, retrying if a worker
   * saved it in the meantime. `mutate` returns null when there is nothing
   * left to do.
   */
  private async mutateFresh(id: string, mutate: (fresh: DevTask) => DevTask | null, attempts = 5): Promise<DevTask> {
    for (let i = 0; ; i++) {
      const fresh = await this.store.getTask(id);
      if (!fresh) throw notFound();
      const next = mutate(fresh);
      if (!next) return fresh;
      try {
        return await this.store.saveTask(next, { expectedRevision: fresh.revision });
      } catch (e) {
        if (e instanceof DevError && e.code === ERR.CONFLICT && i < attempts - 1) continue;
        throw e;
      }
    }
  }

  /**
   * Stops a build. Settling it (consuming spend, crediting the rest) is left
   * to a worker, which is the only thing that can be sure no step of this
   * build is still running and still spending.
   */
  private async finish(task: DevTask, message: string): Promise<DevTask> {
    // A running build is saved by its worker after every step, so a stop can
    // race one. It is applied to the latest version rather than refused.
    let stoppedNow = false;
    const saved = await this.mutateFresh(task.id, (fresh) => {
      if (isTerminal(fresh.state)) return null;
      stoppedNow = true;
      const stopped = transition(fresh, S.CANCELLED, { at: this.iso() });
      return { ...stopped, funding: { ...stopped.funding, settlement: { status: 'pending' } }, nextRunAt: this.iso() };
    });
    if (stoppedNow) await this.event(saved, { kind: 'update', status: 'STOPPED', title: 'Stopped', message });
    return saved;
  }

  private async event(task: DevTask, e: { kind: 'update' | 'chat' | 'audit'; status?: any; role?: 'user' | 'assistant' | 'system'; title: string; message: string }) {
    await this.store.appendEvent({
      taskId: task.id,
      tenantId: task.tenantId,
      kind: e.kind,
      status: e.status ?? null,
      role: e.kind === 'chat' ? e.role ?? 'system' : null,
      title: e.title,
      message: e.message.slice(0, 4_000),
      createdAt: this.iso(),
    });
  }
}

export const CONTROL_VISIBILITY = 'public-visibility';
const CONTROL_VISIBILITY_LOG = 'public-visibility-log';
const VISIBILITY_CACHE_MS = 15_000;
interface VisibilityControl {
  visible: boolean;
  changedBy: string;
  changedAt: string;
  reason: string;
}

const display = (content: string) => (content.startsWith(DECISION_PREFIX) ? content.slice(DECISION_PREFIX.length) : content);
