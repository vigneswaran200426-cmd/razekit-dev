// The Dev Department: RazeKit DEV's own incidents, from intake to resolution.
//
//   INTAKE     builds that failed for a platform reason (not the customer's
//              request), unexpected errors the engine reports, and incidents
//              an operator files — each reduced to a fingerprint, so the same
//              fault seen a hundred times is one incident with a count
//   TRIAGE     severity from frequency and kind; Astra's root cause (the real
//              model only, on the platform budget) when an operator asks
//   FIX        the fix is a reviewed pull request, recorded here — never a
//              model writing to production
//   RESOLVE    closed by an operator; if the same fingerprint comes back it
//              reopens as a REGRESSION, and that history is kept
//
// Stored as platform records in DEV's own schema. Messages are redacted and
// capped before they are kept; no customer request or code is stored.
import type { AstraProvider } from '../engine/providers.js';
import { validateAnalysis, type Analysis } from '../engine/schemas.js';
import { redact } from '../engine/trust.js';
import type { DevStore } from '../store/types.js';

export type IncidentStatus = 'open' | 'triaged' | 'fix_proposed' | 'resolved' | 'regressed';

export interface Incident {
  fingerprint: string;
  source: 'build-failure' | 'error' | 'operator';
  code: string;
  title: string;
  severity: 'low' | 'medium' | 'high';
  status: IncidentStatus;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: { at: string; taskId: string | null; message: string }[];
  analysis: Analysis | null;
  analysisCostMinor: number;
  fix: { pullRequestUrl: string; by: string; at: string } | null;
  regressions: number;
  history: { at: string; by: string; action: string; note: string }[];
}

/** Failure codes that are the platform's fault, not the customer's request. */
export const PLATFORM_FAILURES = new Set([
  'DEV_RUNTIME_UNAVAILABLE',
  'DEV_PROVIDER_FAILED',
  'DEV_PROVIDER_UNAVAILABLE',
  'DEV_LEASE_LOST',
  'DEV_CAPTURE_INVALID',
  'DEV_DELIVERY_FAILED',
]);

const normalise = (m: string) =>
  m
    .replace(/\b(dtk|ws|run|btl|chg)_[a-z0-9]+/gi, '<id>')
    .replace(/[0-9a-f]{8,}/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .slice(0, 160);

const severityOf = (code: string, count: number): Incident['severity'] =>
  count >= 10 || code === 'DEV_RUNTIME_UNAVAILABLE' ? 'high' : count >= 3 ? 'medium' : 'low';

export class DevDepartment {
  constructor(private deps: { store: DevStore; astra: () => AstraProvider; secrets: string[]; platformBudgetLeft: () => Promise<number>; now?: () => Date }) {}

  private iso() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  async intake(e: { source: Incident['source']; code: string; message: string; taskId?: string | null; title?: string }): Promise<Incident> {
    const message = redact(String(e.message ?? ''), this.deps.secrets).slice(0, 500);
    const fingerprint = `${e.source}:${e.code}:${normalise(message)}`;
    const at = this.iso();
    const existing = (await this.deps.store.getRecord<Incident>('incident', fingerprint))?.data;
    const sample = { at, taskId: e.taskId ?? null, message };
    let inc: Incident;
    if (!existing) {
      inc = {
        fingerprint,
        source: e.source,
        code: e.code,
        title: (e.title ?? message.split('\n')[0] ?? e.code).slice(0, 160),
        severity: severityOf(e.code, 1),
        status: 'open',
        count: 1,
        firstSeen: at,
        lastSeen: at,
        samples: [sample],
        analysis: null,
        analysisCostMinor: 0,
        fix: null,
        regressions: 0,
        history: [{ at, by: 'system', action: 'opened', note: '' }],
      };
    } else {
      inc = { ...existing, count: existing.count + 1, lastSeen: at, samples: [sample, ...existing.samples].slice(0, 10) };
      if (existing.status === 'resolved') {
        inc.status = 'regressed';
        inc.regressions = existing.regressions + 1;
        inc.history = [...existing.history, { at, by: 'system', action: 'regressed', note: 'Seen again after it was resolved.' }];
      }
      inc.severity = severityOf(inc.code, inc.count);
    }
    await this.deps.store.putRecord('incident', fingerprint, inc);
    return inc;
  }

  async list(limit = 100): Promise<Incident[]> {
    const all = (await this.deps.store.listRecords<Incident>('incident', { limit })).map((r) => r.data);
    const rank = { regressed: 0, open: 1, triaged: 2, fix_proposed: 3, resolved: 4 } as const;
    const sev = { high: 0, medium: 1, low: 2 } as const;
    return all.sort((a, b) => rank[a.status] - rank[b.status] || sev[a.severity] - sev[b.severity] || (a.lastSeen < b.lastSeen ? 1 : -1));
  }

  private async get(fingerprint: string): Promise<Incident> {
    const rec = await this.deps.store.getRecord<Incident>('incident', fingerprint);
    if (!rec) throw new Error('Incident not found.');
    return rec.data;
  }

  /** Astra's root cause. Real model only, within the platform budget. */
  async analyse(by: string, fingerprint: string): Promise<Incident> {
    const inc = await this.get(fingerprint);
    const astra = this.deps.astra();
    if (!astra.info.available || astra.info.mode !== 'real' || !astra.prepareAnalysis) {
      throw new Error('Root-cause analysis needs the real Astra model; nothing else may stand in for it.');
    }
    const call = astra.prepareAnalysis({
      purpose: 'incident-root-cause',
      subject: inc.title,
      evidence: { code: inc.code, source: inc.source, count: inc.count, firstSeen: inc.firstSeen, lastSeen: inc.lastSeen, regressions: inc.regressions, samples: inc.samples },
    });
    const left = await this.deps.platformBudgetLeft();
    if (call.ceilingMinor > left) throw new Error(`The analysis can cost up to ${call.ceilingMinor} and ${left} of the platform budget is left this month.`);
    try {
      const result = await call.run();
      inc.analysisCostMinor += result.costMinor;
      inc.analysis = validateAnalysis(result.raw);
      if (inc.status === 'open' || inc.status === 'regressed') inc.status = 'triaged';
      inc.history = [...inc.history, { at: this.iso(), by, action: 'analysed', note: inc.analysis.rootCause.slice(0, 300) }];
    } catch (e: any) {
      if (typeof e?.costMinor === 'number') inc.analysisCostMinor += e.costMinor;
      await this.deps.store.putRecord('incident', inc.fingerprint, inc);
      throw new Error(`Astra could not complete the analysis: ${String(e?.message ?? e).slice(0, 300)}`);
    }
    await this.deps.store.putRecord('incident', inc.fingerprint, inc);
    return inc;
  }

  async act(by: string, fingerprint: string, action: 'acknowledge' | 'propose_fix' | 'resolve' | 'reopen', note = '', pullRequestUrl?: string): Promise<Incident> {
    const inc = await this.get(fingerprint);
    const at = this.iso();
    const allowed: Record<string, IncidentStatus[]> = {
      acknowledge: ['open', 'regressed'],
      propose_fix: ['open', 'triaged', 'regressed'],
      resolve: ['triaged', 'fix_proposed', 'open', 'regressed'],
      reopen: ['resolved'],
    };
    if (!allowed[action].includes(inc.status)) throw new Error(`A ${inc.status} incident cannot take "${action}".`);
    if (action === 'propose_fix') {
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pullRequestUrl ?? '')) throw new Error('A fix is a pull request: give its URL.');
      inc.fix = { pullRequestUrl: pullRequestUrl!, by, at };
    }
    inc.status = ({ acknowledge: 'triaged', propose_fix: 'fix_proposed', resolve: 'resolved', reopen: 'open' } as const)[action];
    inc.history = [...inc.history, { at, by, action, note: note.slice(0, 500) }];
    await this.deps.store.putRecord('incident', inc.fingerprint, inc);
    return inc;
  }

  async spentThisMonth(): Promise<number> {
    const month = this.iso().slice(0, 7);
    return (await this.list(1000)).filter((i) => i.lastSeen.slice(0, 7) === month).reduce((s, i) => s + i.analysisCostMinor, 0);
  }
}
