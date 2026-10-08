// Battle Mode: RazeKit DEV improving itself from how real builds went.
//
// Not a loop that calls models for the sake of it, and not a way around any
// rule. It is evidence first:
//
//   OBSERVE     every settled build leaves telemetry (./telemetry.ts)
//   BASELINE    per build type: median and p95 of every phase, failure and
//               retry rates, spend against budget
//   DETECT      a problem is a pattern with enough samples behind it — a
//               phase that dominates, a failure that repeats, retries that
//               pile up, builds that run close to their budget
//   CHALLENGE   Astra (the real model only) turns the strongest candidate
//               into a decision record: cause, smallest safe change, what
//               would prove it, how to undo it
//   IMPLEMENT…  Fable changing RazeKit's own code, the benchmark, staging and
//               canary need a platform build workspace (the repository with
//               its dependencies) that DEV does not have yet. A battle stops
//               at its challenge and says so; promotion is the normal
//               reviewed pull request and deploy, recorded here by an admin.
//
// Hard limits, all admin-set: mode (off / observe / analyze), a monthly and a
// per-battle platform budget — never a customer's build budget — a cycle
// limit and a cooldown between battles. When the budget cannot cover the next
// call, the call is not made.
import { randomUUID } from 'node:crypto';
import type { AstraProvider } from '../engine/providers.js';
import { validateAnalysis, type Analysis } from '../engine/schemas.js';
import type { DevStore, PlatformRecord } from '../store/types.js';
import { PHASES, type BuildTelemetry, type Phase } from './telemetry.js';

export type BattleMode = 'off' | 'observe' | 'analyze';

export interface BattleSettings {
  mode: BattleMode;
  monthlyBudgetMinor: number;
  perBattleBudgetMinor: number;
  maxCycles: number;
  cooldownMinutes: number;
  changedBy?: string;
  changedAt?: string;
}

export const DEFAULT_BATTLE_SETTINGS: BattleSettings = { mode: 'off', monthlyBudgetMinor: 1000, perBattleBudgetMinor: 100, maxCycles: 3, cooldownMinutes: 60 };
export const CONTROL_BATTLE = 'battle-settings';
const MIN_SAMPLES = 5;
const WINDOW = 200;

export interface Baseline {
  taskType: string;
  samples: number;
  completed: number;
  failed: number;
  phases: Record<Phase, { median: number | null; p95: number | null }>;
  totalMedianMs: number | null;
  reworkMedianMs: number | null;
  meanImplementAttempts: number;
  medianBudgetUse: number | null;
  failureCodes: Record<string, number>;
}

export interface Candidate {
  fingerprint: string;
  kind: 'SLOW_PHASE' | 'REPEATED_FAILURE' | 'HIGH_RETRY' | 'BUDGET_PRESSURE' | 'EXCESSIVE_REWORK';
  taskType: string;
  summary: string;
  evidence: Record<string, unknown>;
  /** Frequency × impact; higher first. */
  priority: number;
}

export type BattleStatus = 'challenging' | 'challenged' | 'blocked' | 'no_change' | 'accepted' | 'rejected' | 'promoted' | 'rolled_back';

export interface Battle {
  id: string;
  fingerprint: string;
  candidate: Candidate;
  status: BattleStatus;
  cycle: number;
  maxCycles: number;
  spentMinor: number;
  maxSpendMinor: number;
  stages: { stage: string; status: 'done' | 'blocked' | 'skipped'; at: string; note: string }[];
  analysis: Analysis | null;
  blockedReason: string | null;
  decision: { by: string; at: string; action: string; note: string; pullRequestUrl?: string } | null;
  createdAt: string;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

export function baselines(records: BuildTelemetry[]): Baseline[] {
  const byType = new Map<string, BuildTelemetry[]>();
  for (const r of records) byType.set(r.taskType, [...(byType.get(r.taskType) ?? []), r]);
  return [...byType.entries()].map(([taskType, rs]) => {
    const done = rs.filter((r) => r.outcome === 'completed');
    const phases = {} as Baseline['phases'];
    for (const p of PHASES) {
      const xs = done.map((r) => r.phases[p]).filter((v): v is number => typeof v === 'number');
      phases[p] = { median: quantile(xs, 0.5), p95: quantile(xs, 0.95) };
    }
    const failureCodes: Record<string, number> = {};
    for (const r of rs) if (r.failureCode) failureCodes[r.failureCode] = (failureCodes[r.failureCode] ?? 0) + 1;
    return {
      taskType,
      samples: rs.length,
      completed: done.length,
      failed: rs.filter((r) => r.outcome === 'failed').length,
      phases,
      totalMedianMs: quantile(done.map((r) => r.totalMs), 0.5),
      reworkMedianMs: quantile(done.map((r) => r.reworkMs), 0.5),
      meanImplementAttempts: rs.length ? rs.reduce((s, r) => s + r.attempts.implement, 0) / rs.length : 0,
      medianBudgetUse: quantile(rs.filter((r) => r.maxBudgetMinor > 0).map((r) => r.spentMinor / r.maxBudgetMinor), 0.5),
      failureCodes,
    };
  });
}

/** Patterns with enough samples behind them to be worth a battle. */
export function detect(bs: Baseline[]): Candidate[] {
  const out: Candidate[] = [];
  for (const b of bs) {
    if (b.samples < MIN_SAMPLES) continue;
    const total = b.totalMedianMs ?? 0;
    for (const p of PHASES) {
      const m = b.phases[p].median;
      if (m !== null && total > 0 && m / total > 0.5 && b.completed >= MIN_SAMPLES) {
        out.push({
          fingerprint: `SLOW_PHASE:${b.taskType}:${p}`,
          kind: 'SLOW_PHASE',
          taskType: b.taskType,
          summary: `${p} takes ${Math.round((m / total) * 100)}% of a typical ${b.taskType} build.`,
          evidence: { phase: p, medianMs: m, p95Ms: b.phases[p].p95, totalMedianMs: total, samples: b.completed },
          priority: (m / total) * b.completed,
        });
      }
    }
    for (const [code, n] of Object.entries(b.failureCodes)) {
      if (n >= 3 && n / b.samples >= 0.15) {
        out.push({
          fingerprint: `REPEATED_FAILURE:${b.taskType}:${code}`,
          kind: 'REPEATED_FAILURE',
          taskType: b.taskType,
          summary: `${n} of ${b.samples} ${b.taskType} builds failed with ${code}.`,
          evidence: { failureCode: code, failures: n, samples: b.samples },
          priority: 10 * (n / b.samples) * b.samples,
        });
      }
    }
    if (b.meanImplementAttempts > 2) {
      out.push({
        fingerprint: `HIGH_RETRY:${b.taskType}`,
        kind: 'HIGH_RETRY',
        taskType: b.taskType,
        summary: `${b.taskType} builds need ${b.meanImplementAttempts.toFixed(1)} implementation passes on average.`,
        evidence: { meanImplementAttempts: b.meanImplementAttempts, samples: b.samples },
        priority: b.meanImplementAttempts * b.samples,
      });
    }
    if (b.medianBudgetUse !== null && b.medianBudgetUse > 0.8) {
      out.push({
        fingerprint: `BUDGET_PRESSURE:${b.taskType}`,
        kind: 'BUDGET_PRESSURE',
        taskType: b.taskType,
        summary: `A typical ${b.taskType} build uses ${Math.round(b.medianBudgetUse * 100)}% of its budget.`,
        evidence: { medianBudgetUse: b.medianBudgetUse, samples: b.samples },
        priority: b.medianBudgetUse * b.samples,
      });
    }
    if (b.reworkMedianMs !== null && total > 0 && b.reworkMedianMs / total > 0.4) {
      out.push({
        fingerprint: `EXCESSIVE_REWORK:${b.taskType}`,
        kind: 'EXCESSIVE_REWORK',
        taskType: b.taskType,
        summary: `${Math.round((b.reworkMedianMs / total) * 100)}% of a typical ${b.taskType} build is spent going round again.`,
        evidence: { reworkMedianMs: b.reworkMedianMs, totalMedianMs: total, samples: b.completed },
        priority: (b.reworkMedianMs / total) * b.completed,
      });
    }
  }
  return out.sort((a, b) => b.priority - a.priority);
}

const monthOf = (iso: string) => iso.slice(0, 7);

export class BattleController {
  constructor(private deps: { store: DevStore; astra: () => AstraProvider; now?: () => Date; report?: (e: unknown, c: Record<string, unknown>) => void }) {}

  private iso() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  async settings(): Promise<BattleSettings> {
    return { ...DEFAULT_BATTLE_SETTINGS, ...((await this.deps.store.getControl<BattleSettings>(CONTROL_BATTLE)) ?? {}) };
  }

  async setSettings(by: string, patch: Partial<BattleSettings>): Promise<BattleSettings> {
    const current = await this.settings();
    const next: BattleSettings = { ...current, changedBy: by, changedAt: this.iso() };
    if (patch.mode !== undefined) {
      if (!['off', 'observe', 'analyze'].includes(patch.mode)) throw new Error('mode must be off, observe or analyze.');
      next.mode = patch.mode;
    }
    for (const k of ['monthlyBudgetMinor', 'perBattleBudgetMinor', 'maxCycles', 'cooldownMinutes'] as const) {
      if (patch[k] === undefined) continue;
      const v = Number(patch[k]);
      if (!Number.isInteger(v) || v < 0 || v > 10_000_000) throw new Error(`${k} must be a whole number between 0 and 10000000.`);
      next[k] = v;
    }
    await this.deps.store.setControl(CONTROL_BATTLE, next);
    return next;
  }

  async telemetry(limit = WINDOW): Promise<BuildTelemetry[]> {
    return (await this.deps.store.listRecords<BuildTelemetry>('telemetry', { limit })).map((r) => r.data);
  }

  async battles(limit = 50): Promise<Battle[]> {
    return (await this.deps.store.listRecords<Battle>('battle', { limit })).map((r) => r.data);
  }

  /** Platform spend on battles this calendar month. */
  async spentThisMonth(): Promise<number> {
    const month = monthOf(this.iso());
    return (await this.battles(500)).filter((b) => monthOf(b.createdAt) === month).reduce((s, b) => s + b.spentMinor, 0);
  }

  async overview() {
    const settings = await this.settings();
    const bs = baselines(await this.telemetry());
    return { settings, spentThisMonthMinor: await this.spentThisMonth(), baselines: bs, candidates: detect(bs), battles: await this.battles() };
  }

  /**
   * One pass. Safe to call from every worker: the store's claimOnce makes a
   * given minute's pass run once across the fleet.
   */
  async tick(): Promise<{ ran: boolean; battle?: Battle }> {
    const settings = await this.settings();
    if (settings.mode === 'off') return { ran: false };
    const minute = this.iso().slice(0, 16);
    if (!(await this.deps.store.claimOnce(`battle-tick:${minute}`, { at: this.iso() }))) return { ran: false };
    if (settings.mode === 'observe') return { ran: true };

    const all = await this.battles(500);
    if (all.some((b) => b.status === 'challenging')) return { ran: true };
    const last = all[0];
    if (last && Date.parse(this.iso()) - Date.parse(last.createdAt) < settings.cooldownMinutes * 60_000) return { ran: true };

    const decided = new Set(all.filter((b) => b.status !== 'blocked').map((b) => b.fingerprint));
    const candidate = detect(baselines(await this.telemetry())).find((c) => !decided.has(c.fingerprint));
    if (!candidate) return { ran: true };
    return { ran: true, battle: await this.fight(candidate, settings) };
  }

  /** One bounded battle for one candidate. */
  async fight(candidate: Candidate, settings: BattleSettings): Promise<Battle> {
    const at = this.iso();
    const battle: Battle = {
      id: `btl_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      fingerprint: candidate.fingerprint,
      candidate,
      status: 'challenging',
      cycle: 1,
      maxCycles: settings.maxCycles,
      spentMinor: 0,
      maxSpendMinor: settings.perBattleBudgetMinor,
      stages: [
        { stage: 'OBSERVE', status: 'done', at, note: 'Telemetry from settled builds.' },
        { stage: 'BASELINE', status: 'done', at, note: candidate.summary },
      ],
      analysis: null,
      blockedReason: null,
      decision: null,
      createdAt: at,
    };
    const save = () => this.deps.store.putRecord('battle', battle.id, battle);
    await save();

    const block = async (reason: string) => {
      battle.status = 'blocked';
      battle.blockedReason = reason;
      battle.stages.push({ stage: 'ASTRA_CHALLENGE', status: 'blocked', at: this.iso(), note: reason });
      await save();
      return battle;
    };

    const astra = this.deps.astra();
    if (!astra.info.available || astra.info.mode !== 'real' || !astra.prepareAnalysis) {
      return block('A challenge needs the real Astra model; nothing else may stand in for reasoning about the platform.');
    }
    const call = astra.prepareAnalysis({ purpose: 'battle-challenge', subject: candidate.summary, evidence: { candidate, baseline: candidate.evidence } });
    const monthLeft = settings.monthlyBudgetMinor - (await this.spentThisMonth());
    if (call.ceilingMinor > battle.maxSpendMinor || call.ceilingMinor > monthLeft) {
      return block(`The challenge can cost up to ${call.ceilingMinor} and the platform battle budget allows ${Math.min(battle.maxSpendMinor, monthLeft)} (per battle ${battle.maxSpendMinor}, left this month ${monthLeft}).`);
    }
    try {
      const result = await call.run();
      battle.spentMinor += result.costMinor;
      battle.analysis = validateAnalysis(result.raw);
      battle.status = battle.analysis.decision === 'NO_CHANGE' ? 'no_change' : 'challenged';
      battle.stages.push({ stage: 'ASTRA_CHALLENGE', status: 'done', at: this.iso(), note: `${battle.analysis.decision}: ${battle.analysis.proposedChange}`.slice(0, 500) });
      if (battle.status === 'challenged') {
        battle.stages.push({
          stage: 'FABLE_IMPLEMENT',
          status: 'blocked',
          at: this.iso(),
          note: 'Implementing a change to RazeKit itself needs a platform build workspace (the repository and its dependencies), which is not attached. An engineer takes the challenge from here; promotion is recorded here.',
        });
      }
      await save();
      return battle;
    } catch (e: any) {
      if (typeof e?.costMinor === 'number') battle.spentMinor += e.costMinor;
      return block(`Astra could not complete the challenge: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }

  /** An administrator's decision on a battle, recorded with who and why. */
  async decide(by: string, id: string, action: 'accept' | 'reject' | 'promote' | 'rollback', note: string, pullRequestUrl?: string): Promise<Battle> {
    const rec: PlatformRecord<Battle> | null = await this.deps.store.getRecord<Battle>('battle', id);
    if (!rec) throw new Error('Battle not found.');
    const b = rec.data;
    const allowed: Record<string, BattleStatus[]> = {
      accept: ['challenged'],
      reject: ['challenged', 'accepted', 'blocked'],
      promote: ['accepted'],
      rollback: ['promoted'],
    };
    const verb = { accept: 'accepted', reject: 'rejected', promote: 'promoted', rollback: 'rolled back' }[action];
    if (!verb || !allowed[action]?.includes(b.status)) throw new Error(`A ${b.status} battle cannot be ${verb ?? 'changed that way'}.`);
    if (action === 'promote' && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pullRequestUrl ?? '')) {
      throw new Error('Promotion records the merged pull request that carried the change.');
    }
    b.status = ({ accept: 'accepted', reject: 'rejected', promote: 'promoted', rollback: 'rolled_back' } as const)[action];
    b.decision = { by, at: this.iso(), action, note: note.slice(0, 1000), ...(pullRequestUrl ? { pullRequestUrl } : {}) };
    b.stages.push({ stage: action.toUpperCase(), status: 'done', at: this.iso(), note: note.slice(0, 500) });
    await this.deps.store.putRecord('battle', b.id, b);
    return b;
  }
}
