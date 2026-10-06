// The orchestrator: one build, one transition, per tick.
//
//   queued ─► planning ─► implementing ─► executing ─► reviewing ─► verifying ─► completed
//                              ▲              │            │            │
//                              └── repair ────┴─ revise ───┴─ re-work ──┘
//
// A worker claims a build (with a lease), and the orchestrator moves it exactly
// one step and writes the result. Nothing loops inside a tick, so a build can
// never run away: every step is a separate, observable, interruptible write,
// and a user who cancels or a worker that dies stops it at the next boundary.
//
// Rules this file keeps:
//   • Money before work. Every model call is reserved through the governor
//     before it is made; a reservation that does not fit stops the build and
//     asks the user, it is never retried.
//   • Failures are sorted, not retried blindly. Something outside our control
//     (a provider hiccup, a crash) is retried with backoff up to a limit. Our
//     own limits (budget, attempts, a refused tool, an unconfigured provider)
//     are never retried — the same wall would be hit again.
//   • A stale worker cannot write. Every save presents the lease; if it was
//     lost (the build was recovered elsewhere, or the user changed it), the
//     result is discarded.
//   • A finished build is settled: what it spent is consumed on the ledger and
//     the rest is returned as credit, exactly once.
import { agentDefinition } from './engine/agents.js';
import { DevError, ERR } from './engine/errors.js';
import { BilledFailure, BudgetExceeded, BudgetGovernor } from './engine/governor.js';
import type { ProviderSet } from './engine/providers.js';
import { isTerminal, transition } from './engine/states.js';
import { agentToolset } from './engine/tools.js';
import { validateArchitecturePlan, validateExecutionPlan, validateReview } from './engine/schemas.js';
import { redact } from './engine/trust.js';
import {
  TASK_STATE as S,
  type AcceptanceCriterion,
  type ArchitecturePlan,
  type DashboardStatus,
  type DevChange,
  type DevTask,
} from './engine/types.js';
import type { FundingGate } from './funding.js';
import { ARTIFACT_PATH, type ExecutionRuntime } from './runtime/executor.js';
import type { ClaimedTask, DevStore } from './store/types.js';
import { verifyBuild } from './verification.js';
import { DECISION_PREFIX } from './projection.js';
import { randomUUID } from 'node:crypto';
import type { DevNotifier } from './notify.js';

export interface ArtifactStore {
  put(task: DevTask, bytes: Buffer): Promise<string>;
  signedUrl(uri: string, ttlSeconds: number): Promise<string>;
}

export interface EngineLimits {
  maxImplementAttempts: number;
  maxTransientRetries: number;
  maxInvalidOutputs: number;
  leaseMs: number;
}

export interface OrchestratorDeps {
  store: DevStore;
  providers: ProviderSet;
  runtime: ExecutionRuntime;
  funding: FundingGate;
  artifacts: ArtifactStore | null;
  secrets: string[];
  limits: EngineLimits;
  now?: () => Date;
  /**
   * Keep a finished build's workspace on the worker's disk. Off in normal
   * running: once a build is settled its artifact is in object storage (or it
   * never produced one), and a worker that keeps every workspace eventually
   * runs out of disk.
   */
  keepWorkspaces?: boolean;
  /** Reports an unexpected error. Never throws. */
  report?: (error: unknown, context: Record<string, unknown>) => void;
  /** Tells the owner about decisions and outcomes. Never throws. */
  notifier?: DevNotifier | null;
  /** Called once a build is finished and settled: telemetry, incident intake. */
  onSettled?: (task: DevTask) => Promise<void>;
}

type Emit = {
  kind: 'update' | 'chat' | 'audit';
  status?: DashboardStatus | null;
  role?: 'user' | 'assistant' | 'system' | null;
  title: string;
  message: string;
};

type PhaseResult = { next: DevTask; emits: Emit[] };

export type TickOutcome = 'advanced' | 'waiting' | 'finished' | 'retry' | 'lost' | 'settled';

const LABEL = { niomi: 'Niomi', konami: 'Konami' } as const;

export class Orchestrator {
  readonly governor: BudgetGovernor;
  private now: () => Date;

  constructor(private deps: OrchestratorDeps) {
    this.governor = new BudgetGovernor(deps.store);
    this.now = deps.now ?? (() => new Date());
  }

  /** Runs one tick for a claimed build, keeping its lease alive meanwhile. */
  async run(claim: ClaimedTask): Promise<TickOutcome> {
    const { store, limits } = this.deps;
    const heartbeat = setInterval(() => {
      store.extendLease(claim.task.id, claim.leaseToken, limits.leaseMs).catch(() => undefined);
    }, Math.max(1_000, Math.floor(limits.leaseMs / 3)));
    try {
      return await this.tick(claim);
    } catch (e) {
      this.deps.report?.(e, { where: 'orchestrator.run', taskId: claim.task.id });
      return 'retry';
    } finally {
      clearInterval(heartbeat);
      await store.releaseLease(claim.task.id, claim.leaseToken).catch(() => undefined);
    }
  }

  private async tick(claim: ClaimedTask): Promise<TickOutcome> {
    const task = claim.task;
    await this.releaseOrphans(task);

    if (isTerminal(task.state)) return this.settle(claim, task);
    if (task.state === S.AWAITING_FUNDING) return this.recoverFunding(claim, task);

    let result: PhaseResult;
    try {
      result = await this.phase(task);
    } catch (e) {
      return this.handleFailure(claim, task, e);
    }
    const saved = await this.save(claim, result.next);
    if (!saved) return 'lost';
    await this.emitAll(saved, result.emits);
    if (isTerminal(saved.state)) return this.settle(claim, saved);
    return saved.state === S.WAITING_USER ? 'waiting' : 'advanced';
  }

  // ── Phases ──────────────────────────────────────────────────────────────────

  private phase(task: DevTask): Promise<PhaseResult> {
    switch (task.state) {
      case S.QUEUED:
        return this.start(task);
      case S.PLANNING:
        return this.plan(task);
      case S.IMPLEMENTING:
        return this.implement(task);
      case S.EXECUTING:
        return this.execute(task);
      case S.REVIEWING:
        return this.review(task);
      case S.VERIFYING:
        return this.verify(task);
      default:
        throw new DevError(ERR.STATE, `Nothing to do for a build in ${task.state}.`);
    }
  }

  private async start(task: DevTask): Promise<PhaseResult> {
    if (!this.deps.runtime.status.available) {
      throw new DevError(ERR.RUNTIME_UNAVAILABLE, this.deps.runtime.status.reason || 'No build runtime is available.');
    }
    await this.deps.runtime.workspaces.ensure(task.workspaceId);
    const agent = LABEL[task.agentType];
    return {
      next: transition(task, S.PLANNING, { at: this.iso() }),
      emits: [
        { kind: 'update', status: 'WORKING', title: 'Build started', message: `${agent} is planning your ${task.taskType}.` },
        { kind: 'chat', role: 'assistant', title: agent, message: `I'm on it. First I'll plan the ${task.taskType}, then write it, test it and check it.` },
      ],
    };
  }

  private async plan(task: DevTask): Promise<PhaseResult> {
    const agent = agentDefinition(task.agentType);
    const { usable, unavailable } = agentToolset(agent, this.deps.runtime.availability());
    const prepared = this.deps.providers.astra.preparePlan({ task, agent, usableTools: usable, unavailableTools: unavailable });
    const { value: plan } = await this.governor.run(
      task,
      this.meter(task, 'plan', 'astra', prepared.ceilingMinor),
      async () => {
        const r = await prepared.run();
        try {
          return { value: validateArchitecturePlan(r.raw), costMinor: r.costMinor };
        } catch (e) {
          throw new BilledFailure(e, r.costMinor);
        }
      }
    );
    const acceptance = mergeAcceptance(task.acceptance, plan);
    const next = transition(
      { ...task, acceptance, blackboard: { ...task.blackboard, architecturePlan: plan }, attempts: reset(task.attempts) },
      S.IMPLEMENTING,
      { at: this.iso() }
    );
    return {
      next,
      emits: [
        { kind: 'update', status: 'WORKING', title: 'Plan ready', message: plan.summary },
        {
          kind: 'chat',
          role: 'assistant',
          title: LABEL[task.agentType],
          message: `Here's the plan: ${plan.summary} It's done when: ${acceptance.map((c) => c.text).join('; ')}.`,
        },
      ],
    };
  }

  private async implement(task: DevTask): Promise<PhaseResult> {
    const { limits, providers, runtime } = this.deps;
    if (task.attempts.implement >= limits.maxImplementAttempts) {
      throw new DevError(ERR.ATTEMPTS_EXHAUSTED, `The build failed ${task.attempts.implement} times and was stopped rather than spending more.`);
    }
    const plan = task.blackboard.architecturePlan;
    if (!plan) throw new DevError(ERR.STATE, 'There is no plan to implement.');
    const agent = agentDefinition(task.agentType);
    const availability = runtime.availability();
    const provided = runtime.providedFiles(agent);
    const refinements = await this.appliedChanges(task.id);

    const prepared = providers.fable.prepareImplement({
      task,
      agent,
      plan,
      previous: task.blackboard.executionPlan,
      lastResult: task.blackboard.lastResult,
      review: task.blackboard.lastReview,
      refinements: refinements.map((c) => ({ id: c.id, content: c.content })),
      repairNotes: task.blackboard.repairNotes,
      usableTools: agentToolset(agent, availability).usable,
      providedFiles: provided.map((p) => ({ path: p.path, description: p.description })),
    });
    const { value: execPlan } = await this.governor.run(
      task,
      this.meter(task, 'implement', 'fable', prepared.ceilingMinor),
      async () => {
        const r = await prepared.run();
        try {
          return { value: validateExecutionPlan(r.raw, agent, availability, provided.map((p) => p.path)), costMinor: r.costMinor };
        } catch (e) {
          throw new BilledFailure(e, r.costMinor);
        }
      }
    );

    const attempts = { ...reset(task.attempts), implement: task.attempts.implement + 1 };
    const next = transition(
      {
        ...task,
        attempts,
        blackboard: {
          ...task.blackboard,
          executionPlan: execPlan,
          refinements: refinements.map((c) => ({ changeId: c.id, content: c.content, at: this.iso() })),
        },
      },
      S.EXECUTING,
      { at: this.iso() }
    );
    const emits: Emit[] = [
      {
        kind: 'update',
        status: 'WORKING',
        title: attempts.implement > 1 ? 'Code rewritten' : 'Code written',
        message: `${execPlan.files.length} files written${attempts.implement > 1 ? ` (attempt ${attempts.implement})` : ''}. Running tests and the build next.`,
      },
    ];
    if (execPlan.notes) emits.push({ kind: 'chat', role: 'assistant', title: LABEL[task.agentType], message: execPlan.notes });
    return { next, emits };
  }

  private async execute(task: DevTask): Promise<PhaseResult> {
    const plan = task.blackboard.executionPlan;
    if (!plan) throw new DevError(ERR.STATE, 'There is no code to run.');
    const agent = agentDefinition(task.agentType);
    const result = await this.deps.runtime.execute({ workspaceId: task.workspaceId, agent, plan });
    const withResult: DevTask = { ...task, blackboard: { ...task.blackboard, lastResult: result } };

    if (result.ok) {
      const scan = await this.deps.runtime.workspaces.scan(task.workspaceId, plan.output.dir);
      const prefix = `${plan.output.dir}/`;
      const deliverables = scan.files.map((f) => ({ ...f, path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path }));
      return {
        next: transition({ ...withResult, deliverables, artifact: result.artifact, blackboard: { ...withResult.blackboard, repairNotes: [] } }, S.REVIEWING, { at: this.iso() }),
        emits: [{ kind: 'update', status: 'WORKING', title: 'Tests and build passed', message: `${result.steps.length} steps passed. Reviewing what was built.` }],
      };
    }

    const failed = result.steps.filter((s) => s.status === 'failed');
    const notes = failed.map((s) => `${s.id} (${s.tool}) failed: ${(s.error || '').slice(0, 300)}\n${s.output.slice(-1500)}`);
    if (task.attempts.implement >= this.deps.limits.maxImplementAttempts) {
      return this.fail(withResult, ERR.ATTEMPTS_EXHAUSTED, `The build failed ${task.attempts.implement} times. Last failure: ${failed.map((s) => s.id).join(', ')}.`);
    }
    return {
      next: transition({ ...withResult, blackboard: { ...withResult.blackboard, repairNotes: notes } }, S.IMPLEMENTING, { at: this.iso() }),
      emits: [{ kind: 'update', status: 'IMPORTANT UPDATE', title: 'Fixing a failure', message: `${failed.map((s) => s.id).join(', ')} did not pass. Repairing it.` }],
    };
  }

  private async review(task: DevTask): Promise<PhaseResult> {
    const { architecturePlan: plan, executionPlan, lastResult } = task.blackboard;
    if (!plan || !executionPlan || !lastResult) throw new DevError(ERR.STATE, 'There is nothing to review yet.');
    const agent = agentDefinition(task.agentType);
    const prepared = this.deps.providers.astra.prepareReview({ task, agent, plan, executionPlan, result: lastResult, criteria: task.acceptance });
    const { value: verdict } = await this.governor.run(
      task,
      this.meter(task, 'review', 'astra', prepared.ceilingMinor),
      async () => {
        const r = await prepared.run();
        try {
          return { value: validateReview(r.raw), costMinor: r.costMinor };
        } catch (e) {
          throw new BilledFailure(e, r.costMinor);
        }
      }
    );
    const reviewed: DevTask = {
      ...task,
      attempts: { ...reset(task.attempts), review: task.attempts.review + 1 },
      blackboard: { ...task.blackboard, lastReview: verdict },
    };

    if (verdict.decision === 'block') {
      const change = await this.decisionChange(reviewed, 'Carry on despite the reviewer', `The reviewer stopped this build: ${verdict.summary} ${verdict.issues.join(' ')}`.trim(), 0);
      return {
        next: transition(reviewed, S.WAITING_USER, {
          at: this.iso(),
          resumeTo: S.IMPLEMENTING,
          decision: { kind: 'review_block', message: verdict.summary, changeId: change.id },
        }),
        emits: [{ kind: 'update', status: 'DECISION NEEDED', title: 'Needs your decision', message: verdict.summary }],
      };
    }
    if (verdict.decision === 'revise') {
      if (task.attempts.implement >= this.deps.limits.maxImplementAttempts) {
        return this.fail(reviewed, ERR.ATTEMPTS_EXHAUSTED, `The reviewer still had issues after ${task.attempts.implement} attempts: ${verdict.issues.slice(0, 3).join('; ')}`);
      }
      return {
        next: transition({ ...reviewed, blackboard: { ...reviewed.blackboard, repairNotes: verdict.issues } }, S.IMPLEMENTING, { at: this.iso() }),
        emits: [{ kind: 'update', status: 'WORKING', title: 'Improving it', message: verdict.summary }],
      };
    }
    return {
      next: transition(reviewed, S.VERIFYING, { at: this.iso() }),
      emits: [{ kind: 'update', status: 'WORKING', title: 'Review passed', message: 'Checking the result against the evidence.' }],
    };
  }

  private async verify(task: DevTask): Promise<PhaseResult> {
    const plan = task.blackboard.executionPlan;
    if (!plan) throw new DevError(ERR.STATE, 'There is nothing to verify.');
    // Fresh budget columns: verification checks the money as it is now.
    const fresh = (await this.deps.store.getTask(task.id)) ?? task;
    const current: DevTask = { ...task, spentMinor: fresh.spentMinor, reservedMinor: fresh.reservedMinor, maxBudgetMinor: fresh.maxBudgetMinor };
    const agent = agentDefinition(task.agentType);
    const outcome = await verifyBuild({ runtime: this.deps.runtime, task: current, agent, plan, secrets: this.deps.secrets, at: this.iso() });
    const verified: DevTask = {
      ...task,
      acceptance: outcome.acceptance,
      verification: outcome.report,
      attempts: { ...reset(task.attempts), verify: task.attempts.verify + 1 },
    };

    // A change the user asked for after this code was written is not in it.
    // Completing now would hand them something they already asked to change.
    const pending = await this.unincorporatedChanges(task);
    if (outcome.report.status === 'passed' && pending.length === 0) {
      const stored = await this.storeArtifact(verified);
      return {
        next: transition(stored, S.COMPLETED, { at: this.iso() }),
        emits: [
          { kind: 'update', status: 'COMPLETED', title: 'Done', message: 'Built, tested and verified.' },
          { kind: 'chat', role: 'assistant', title: LABEL[task.agentType], message: 'It is finished, tested and verified. The deliverables are ready to download.' },
        ],
      };
    }
    if (outcome.report.status === 'passed') {
      return {
        next: transition(verified, S.IMPLEMENTING, { at: this.iso() }),
        emits: [{ kind: 'update', status: 'WORKING', title: 'Applying your changes', message: `${pending.length} requested change(s) still to apply.` }],
      };
    }
    if (task.attempts.implement >= this.deps.limits.maxImplementAttempts) {
      return this.fail(verified, ERR.ATTEMPTS_EXHAUSTED, `Verification still failed after ${task.attempts.implement} attempts: ${outcome.report.failures.slice(0, 3).map((f) => f.reason).join('; ')}`);
    }
    return {
      next: transition(
        { ...verified, blackboard: { ...verified.blackboard, repairNotes: outcome.report.failures.map((f) => `${f.check}: ${f.reason}`) } },
        S.IMPLEMENTING,
        { at: this.iso() }
      ),
      emits: [{ kind: 'update', status: 'IMPORTANT UPDATE', title: 'Checks did not pass', message: outcome.report.failures.slice(0, 2).map((f) => f.reason).join(' ') }],
    };
  }

  // ── Failure handling ────────────────────────────────────────────────────────

  private async handleFailure(claim: ClaimedTask, task: DevTask, e: unknown): Promise<TickOutcome> {
    const { limits } = this.deps;

    if (e instanceof BudgetExceeded) {
      const change = await this.decisionChange(task, 'Raise the budget to continue', `The next step can cost up to ${money(e.requiredMinor)} and ${money(e.availableMinor)} of your limit is left. Raise the limit to carry on, or stop here and keep what is built so far.`, e.requiredMinor);
      const next = transition(task, S.WAITING_USER, {
        at: this.iso(),
        decision: { kind: 'budget', message: `This build reached its budget limit.`, changeId: change.id, requiredMinor: e.requiredMinor },
      });
      const saved = await this.save(claim, next);
      if (!saved) return 'lost';
      await this.emitAll(saved, [{ kind: 'update', status: 'DECISION NEEDED', title: 'Budget limit reached', message: 'The build stopped at your limit and is waiting for you.' }]);
      return 'waiting';
    }

    const err = e instanceof DevError ? e : null;
    const invalidOutput = err && [ERR.PROVIDER_OUTPUT, ERR.PLAN_INVALID, ERR.PATH, ERR.TOOL_DENIED, ERR.TOOL_UNAVAILABLE].includes(err.code as any);

    if (invalidOutput) {
      const count = task.attempts.invalidOutput + 1;
      if (count > limits.maxInvalidOutputs) {
        return this.saveFailure(claim, task, err!.code, `The model kept producing unusable output: ${err!.message}`);
      }
      const notes = task.state === S.IMPLEMENTING ? [...task.blackboard.repairNotes, `Your last answer was rejected: ${err!.message}`] : task.blackboard.repairNotes;
      const saved = await this.save(claim, {
        ...task,
        attempts: { ...task.attempts, invalidOutput: count },
        blackboard: { ...task.blackboard, repairNotes: notes.slice(-20) },
        nextRunAt: this.iso(),
        updatedAt: this.iso(),
      });
      if (!saved) return 'lost';
      await this.emitAll(saved, [{ kind: 'audit', title: 'Model output rejected', message: redact(err!.message, this.deps.secrets) }]);
      return 'retry';
    }

    if (err && !err.retryable) {
      return this.saveFailure(claim, task, err.code, err.message);
    }

    // Outside our control: a provider hiccup, a network failure, a crash in a
    // step. Retried with backoff, but not forever.
    const count = task.attempts.transient + 1;
    this.deps.report?.(e, { where: 'orchestrator.tick', taskId: task.id, state: task.state, attempt: count });
    if (count > limits.maxTransientRetries) {
      return this.saveFailure(claim, task, err?.code ?? 'DEV_INTERNAL', `Stopped after ${limits.maxTransientRetries} retries: ${err?.message ?? 'an internal error'}`);
    }
    const backoffMs = Math.min(5 * 60_000, 5_000 * 2 ** (count - 1));
    const saved = await this.save(claim, {
      ...task,
      attempts: { ...task.attempts, transient: count },
      nextRunAt: new Date(this.now().getTime() + backoffMs).toISOString(),
      updatedAt: this.iso(),
    });
    if (!saved) return 'lost';
    await this.emitAll(saved, [{ kind: 'audit', title: 'Retrying', message: `Attempt ${count}: ${redact(err?.message ?? String(e), this.deps.secrets).slice(0, 300)}` }]);
    return 'retry';
  }

  private fail(task: DevTask, code: string, message: string): PhaseResult {
    return {
      next: transition(task, S.FAILED, { at: this.iso(), failure: { code, message } }),
      emits: [
        { kind: 'update', status: 'BLOCKED', title: 'Stopped', message },
        { kind: 'chat', role: 'system', title: 'RazeKit', message: `This build stopped: ${message}` },
      ],
    };
  }

  private async saveFailure(claim: ClaimedTask, task: DevTask, code: string, message: string): Promise<TickOutcome> {
    const { next, emits } = this.fail(task, code, redact(message, this.deps.secrets));
    const saved = await this.save(claim, next);
    if (!saved) return 'lost';
    await this.emitAll(saved, emits);
    return this.settle(claim, saved);
  }

  // ── Money ───────────────────────────────────────────────────────────────────

  private meter(task: DevTask, operation: string, provider: string, ceilingMinor: number) {
    // Stable for one attempt at one step: a retried tick of the same revision
    // replays this reservation instead of taking a second one.
    return { reservationId: `${task.id}:r${task.revision}:${operation}`, kind: 'model' as const, provider, operation, ceilingMinor };
  }

  /**
   * Returns reservations left behind by an earlier tick that never settled
   * them. We hold the lease, so no other tick for this build is running and
   * anything still reserved from a previous revision is an orphan.
   */
  private async releaseOrphans(task: DevTask) {
    const current = `${task.id}:r${task.revision}:`;
    for (const s of await this.deps.store.listSpend(task.id)) {
      if (s.status === 'reserved' && (!s.reservationId.startsWith(current) || isTerminal(task.state))) {
        await this.deps.store.releaseSpend(task.id, s.reservationId).catch(() => undefined);
      }
    }
  }

  /** Settles a finished build with the ledger, once. */
  private async settle(claim: ClaimedTask, task: DevTask): Promise<TickOutcome> {
    const fresh = (await this.deps.store.getTask(task.id)) ?? task;
    if (fresh.funding.settlement?.status === 'settled') {
      if (fresh.nextRunAt) await this.save(claim, { ...fresh, nextRunAt: null });
      return 'finished';
    }
    try {
      const r = await this.deps.funding.settle(fresh);
      const saved = await this.save(claim, {
        ...fresh,
        funding: { ...fresh.funding, settlement: { status: 'settled', consumedMinor: r.consumedMinor, creditedMinor: r.creditedMinor, settledAt: this.iso() } },
        nextRunAt: null,
        updatedAt: this.iso(),
      });
      if (!saved) return 'lost';
      if (r.creditedMinor > 0) {
        await this.emitAll(saved, [{ kind: 'update', status: null, title: 'Unused budget returned', message: `${money(r.creditedMinor)} came back to you as development credit.` }]);
      }
      await this.cleanWorkspace(saved);
      // What the platform learns from a finished build. Never fails the build.
      await this.deps.onSettled?.(saved).catch((e) => this.deps.report?.(e, { where: 'orchestrator.onSettled', taskId: saved.id }));
      return 'settled';
    } catch (e) {
      this.deps.report?.(e, { where: 'orchestrator.settle', taskId: task.id });
      await this.save(claim, {
        ...fresh,
        funding: { ...fresh.funding, settlement: { status: 'pending', error: redact((e as Error).message, this.deps.secrets).slice(0, 300) } },
        nextRunAt: new Date(this.now().getTime() + 60_000).toISOString(),
        updatedAt: this.iso(),
      });
      return 'retry';
    }
  }

  /** A build created but not yet funded — the creating request died midway. */
  private async recoverFunding(claim: ClaimedTask, task: DevTask): Promise<TickOutcome> {
    try {
      const reservation = await this.deps.funding.secure(task);
      const next = transition(
        { ...task, funding: { ...task.funding, reservations: reservation ? [reservation] : [] } },
        S.QUEUED,
        { at: this.iso() }
      );
      return (await this.save(claim, next)) ? 'advanced' : 'lost';
    } catch (e) {
      const message = e instanceof DevError ? e.message : 'The build could not be funded.';
      const saved = await this.save(claim, transition(task, S.FAILED, { at: this.iso(), failure: { code: ERR.INSUFFICIENT_FUNDS, message } }));
      return saved ? 'finished' : 'lost';
    }
  }

  // ── Changes the user asked for ──────────────────────────────────────────────

  /**
   * The changes the user wants in the code: refinements applied on arrival and
   * boundary changes they approved. Not the build's own questions (a budget
   * stop, a reviewer's block) — answering those is not a code change, and
   * handing "raise the budget" to the implementer as an instruction would be
   * nonsense at best.
   */
  private async appliedChanges(taskId: string): Promise<DevChange[]> {
    const changes = await this.deps.store.listChanges(taskId, { status: ['applied', 'approved'] });
    return changes.filter((c) => c.classification !== 'out_of_scope' && !c.content.startsWith(DECISION_PREFIX));
  }

  private async unincorporatedChanges(task: DevTask): Promise<DevChange[]> {
    const done = new Set(task.blackboard.refinements.map((r) => r.changeId));
    return (await this.appliedChanges(task.id)).filter((c) => !done.has(c.id));
  }

  /** A question for the user, shown as a pending decision they can approve or decline. */
  private async decisionChange(task: DevTask, title: string, reason: string, requiredMinor: number): Promise<DevChange> {
    const fresh = (await this.deps.store.getTask(task.id)) ?? task;
    const neededTotal = fresh.spentMinor + fresh.reservedMinor + requiredMinor;
    return this.deps.store.insertChange({
      id: `chg_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      taskId: task.id,
      tenantId: task.tenantId,
      content: `${DECISION_PREFIX}${title}`,
      classification: 'boundary',
      status: 'pending',
      reason,
      budgetSnapshot: {
        projectedSpend: Math.ceil(neededTotal / 100),
        projectedSpendMinor: neededTotal,
        remainingMinor: Math.max(0, fresh.maxBudgetMinor - fresh.spentMinor - fresh.reservedMinor),
        withinBudget: neededTotal <= fresh.maxBudgetMinor,
      },
      createdAt: this.iso(),
      resolvedAt: null,
    });
  }

  // ── Plumbing ────────────────────────────────────────────────────────────────

  /**
   * Removes a settled build's workspace — unless it holds the only copy of a
   * completed build (no object storage configured), or keeping is configured.
   */
  private async cleanWorkspace(task: DevTask) {
    if (this.deps.keepWorkspaces) return;
    if (task.state === S.COMPLETED && !task.artifact?.storageUri) return;
    await this.deps.runtime.workspaces.remove(task.workspaceId).catch((e) => {
      this.deps.report?.(e, { where: 'orchestrator.cleanWorkspace', taskId: task.id });
    });
  }

  private async storeArtifact(task: DevTask): Promise<DevTask> {
    if (!task.artifact || !this.deps.artifacts) return task;
    const bytes = await this.deps.runtime.workspaces.readBytes(task.workspaceId, ARTIFACT_PATH);
    if (!bytes) throw new DevError(ERR.PROVIDER_FAILED, 'The verified artifact disappeared before it could be stored.', { retryable: true });
    // A storage failure is retried as transient: a build is not "done" if the
    // customer cannot download it.
    const storageUri = await this.deps.artifacts.put(task, bytes);
    return { ...task, artifact: { ...task.artifact, storageUri } };
  }

  private async save(claim: ClaimedTask, next: DevTask): Promise<DevTask | null> {
    try {
      const saved = await this.deps.store.saveTask(next, { expectedRevision: claim.task.revision, leaseToken: claim.leaseToken });
      claim.task = saved;
      return saved;
    } catch (e) {
      if (e instanceof DevError && (e.code === ERR.CONFLICT || e.code === ERR.LEASE_LOST)) return null;
      throw e;
    }
  }

  private async emitAll(task: DevTask, emits: Emit[]) {
    for (const e of emits) {
      await this.deps.store.appendEvent({
        taskId: task.id,
        tenantId: task.tenantId,
        kind: e.kind,
        status: e.status ?? null,
        role: e.kind === 'chat' ? e.role ?? 'assistant' : null,
        title: e.title,
        message: redact(e.message, this.deps.secrets).slice(0, 4_000),
        createdAt: this.iso(),
      });
    }
    await this.notifyFor(task);
  }

  /** The moments a person should hear about. The notifier sends each once. */
  private async notifyFor(task: DevTask) {
    const n = this.deps.notifier;
    if (!n) return;
    if (task.state === S.COMPLETED) await n.notify(task, 'completed');
    else if (task.state === S.FAILED) await n.notify(task, 'failed');
    else if (task.state === S.WAITING_USER && task.decision) await n.notify(task, 'decision');
  }


  private iso() {
    return this.now().toISOString();
  }
}


function reset(a: DevTask['attempts']): DevTask['attempts'] {
  return { ...a, transient: 0, invalidOutput: 0 };
}

const money = (minor: number) => `$${(Math.max(0, minor) / 100).toFixed(2)}`;

/** User criteria keep their ids and gain a check where the plan offers one; the plan's own criteria follow. */
export function mergeAcceptance(existing: AcceptanceCriterion[], plan: ArchitecturePlan): AcceptanceCriterion[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const used = new Set<number>();
  const user = existing
    .filter((c) => c.source === 'user')
    .map((c) => {
      if (c.check) return c;
      const i = plan.acceptance.findIndex((a, idx) => !used.has(idx) && a.check && (norm(a.text) === norm(c.text) || norm(a.text).includes(norm(c.text)) || norm(c.text).includes(norm(a.text))));
      if (i < 0) return c;
      used.add(i);
      return { ...c, check: plan.acceptance[i].check };
    });
  const userTexts = new Set(user.map((c) => norm(c.text)));
  const fromPlan = plan.acceptance
    .filter((a, idx) => !used.has(idx) && !userTexts.has(norm(a.text)))
    .map((a, i) => ({ id: `plan-${i + 1}`, text: a.text, source: 'plan' as const, check: a.check, status: 'pending' as const }));
  return [...user, ...fromPlan];
}

