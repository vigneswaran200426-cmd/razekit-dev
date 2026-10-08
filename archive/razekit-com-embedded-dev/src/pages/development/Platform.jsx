import { useCallback, useEffect, useState } from 'react';
import { development } from '@/lib/api';
import { isAbandonedRequest } from '@/lib/development';
import { Badge, Button, Card, Input, Label } from '@/components/ui';

// Operator panels for RazeKit DEV improving itself: Battle Mode and the Dev
// Department. Every number shown comes from the API; nothing here is computed
// or invented in the browser, and every action is enforced server-side.

const money = (minor) => `$${(Math.max(0, Number(minor) || 0) / 100).toFixed(2)}`;
const secs = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);
const MODES = [
  { id: 'off', label: 'Off' },
  { id: 'observe', label: 'Observe only' },
  { id: 'analyze', label: 'Analyze' },
];
const BATTLE_TONE = { challenged: 'warning', blocked: 'danger', accepted: 'success', promoted: 'success', rejected: 'neutral', rolled_back: 'danger', no_change: 'neutral', challenging: 'primary' };
const SEVERITY_TONE = { high: 'danger', medium: 'warning', low: 'neutral' };

function useLoad(fn) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async (signal) => {
    try {
      setData(await fn({ signal }));
      setError(null);
    } catch (e) {
      if (!isAbandonedRequest(e)) setError(e.message || 'Could not load');
    }
  }, [fn]);
  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);
  return { data, error, load, setError };
}

export function BattlePanel() {
  const { data, error, load, setError } = useLoad(development.battle);
  const [busy, setBusy] = useState(false);
  const [prUrl, setPrUrl] = useState('');
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="font-display text-base font-bold text-ink">Battle Mode</h2>
      <p className="mt-1 text-[13px] text-muted">
        Learns from real builds, finds what slows or breaks them, and has Astra challenge it. It spends the platform budget below, never a customer&apos;s, and never changes code by itself.
      </p>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      {data && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Battle Mode">
            {MODES.map((m) => (
              <Button
                key={m.id}
                size="sm"
                variant={data.settings.mode === m.id ? 'primary' : 'secondary'}
                disabled={busy}
                aria-pressed={data.settings.mode === m.id}
                onClick={() => act(() => development.setBattle({ mode: m.id }))}
              >
                {m.label}
              </Button>
            ))}
            <span className="text-[13px] text-muted">
              Spent this month {money(data.spentThisMonthMinor)} of {money(data.settings.monthlyBudgetMinor)} · per battle up to {money(data.settings.perBattleBudgetMinor)}
            </span>
          </div>

          <div>
            <p className="text-[13px] font-medium text-ink">Baselines from settled builds</p>
            {data.baselines.length === 0 ? (
              <p className="mt-1 text-[13px] text-muted">No settled builds yet.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {data.baselines.map((b) => (
                  <li key={b.taskType} className="text-[13px] text-muted">
                    <span className="font-medium text-ink">{b.taskType}</span> · {b.samples} builds ({b.failed} failed) · typical {secs(b.totalMedianMs)} ·{' '}
                    {['plan', 'implement', 'execute', 'review', 'verify'].map((p) => `${p} ${secs(b.phases[p].median)}`).join(' · ')}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="text-[13px] font-medium text-ink">Detected</p>
            {data.candidates.length === 0 ? (
              <p className="mt-1 text-[13px] text-muted">Nothing with enough evidence behind it.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {data.candidates.slice(0, 6).map((c) => (
                  <li key={c.fingerprint} className="text-[13px] text-muted"><Badge tone="warning">{c.kind.replace(/_/g, ' ').toLowerCase()}</Badge> {c.summary}</li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="text-[13px] font-medium text-ink">Battles</p>
            {data.battles.length === 0 ? (
              <p className="mt-1 text-[13px] text-muted">None yet.</p>
            ) : (
              <ul className="mt-2 space-y-3">
                {data.battles.slice(0, 8).map((b) => (
                  <li key={b.id} className="rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={BATTLE_TONE[b.status] || 'neutral'}>{b.status.replace('_', ' ')}</Badge>
                      <span className="text-[13px] font-medium text-ink">{b.candidate.summary}</span>
                      <span className="text-[12px] text-muted">{money(b.spentMinor)} spent</span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted">{b.stages.map((s) => `${s.stage} ${s.status}`).join(' → ')}</p>
                    {b.blockedReason && <p className="mt-1 text-[13px] text-danger">{b.blockedReason}</p>}
                    {b.analysis && (
                      <dl className="mt-2 grid gap-1 text-[13px]">
                        <div><dt className="inline font-medium text-ink">Cause: </dt><dd className="inline text-muted">{b.analysis.rootCause}</dd></div>
                        <div><dt className="inline font-medium text-ink">Change: </dt><dd className="inline text-muted">{b.analysis.proposedChange}</dd></div>
                        <div><dt className="inline font-medium text-ink">Proof: </dt><dd className="inline text-muted">{b.analysis.benchmark}</dd></div>
                        <div><dt className="inline font-medium text-ink">Undo: </dt><dd className="inline text-muted">{b.analysis.rollbackPlan}</dd></div>
                      </dl>
                    )}
                    {b.decision?.pullRequestUrl && (
                      <a className="mt-1 inline-block text-[13px] text-ink underline" href={b.decision.pullRequestUrl} target="_blank" rel="noreferrer">Pull request</a>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {b.status === 'challenged' && (
                        <>
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => development.decideBattle(b.id, { action: 'accept', note: 'Accepted for implementation' }))}>Accept</Button>
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => development.decideBattle(b.id, { action: 'reject', note: 'Rejected' }))}>Reject</Button>
                        </>
                      )}
                      {b.status === 'accepted' && (
                        <>
                          <Input aria-label="Merged pull request URL" placeholder="https://github.com/…/pull/123" value={prUrl} onChange={(e) => setPrUrl(e.target.value)} className="min-w-0 flex-1" />
                          <Button size="sm" variant="secondary" disabled={busy || !prUrl.trim()} onClick={() => act(() => development.decideBattle(b.id, { action: 'promote', note: 'Merged and deployed', pullRequestUrl: prUrl.trim() }))}>Record promotion</Button>
                        </>
                      )}
                      {b.status === 'promoted' && (
                        <Button size="sm" variant="outlineDanger" disabled={busy} onClick={() => act(() => development.decideBattle(b.id, { action: 'rollback', note: 'Rolled back' }))}>Record rollback</Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-medium text-ink">Benchmark</p>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => development.runBenchmark())}>Run benchmark</Button>
            </div>
            {data.benchmarks.length === 0 ? (
              <p className="mt-1 text-[13px] text-muted">Not run yet. It builds a website, an app and a game for real and times them.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {data.benchmarks.slice(0, 5).map((r) => (
                  <li key={r.id} className="text-[13px] text-muted">
                    <Badge tone={r.ok ? 'success' : 'danger'}>{r.ok ? 'passed' : 'failed'}</Badge> {new Date(r.at).toLocaleString()} · {secs(r.totalMs)}
                    {r.deltaMs !== null && <span className={r.deltaMs <= 0 ? 'text-success' : 'text-danger'}> ({r.deltaMs <= 0 ? '' : '+'}{secs(r.deltaMs)} vs previous)</span>}
                    {' · '}{r.builds.map((b) => `${b.taskType} ${secs(b.totalMs)}`).join(' · ')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function DevDepartmentPanel() {
  const { data, error, load, setError } = useLoad(development.incidents);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [fixUrl, setFixUrl] = useState({});
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message || 'That did not work');
    } finally {
      setBusy(false);
    }
  };
  const doAction = (fingerprint, action, extra = {}) => act(() => development.incidentAction({ fingerprint, action, ...extra }));

  return (
    <Card className="p-5">
      <h2 className="font-display text-base font-bold text-ink">Dev Department</h2>
      <p className="mt-1 text-[13px] text-muted">
        Incidents from builds that failed for a platform reason, from unexpected errors, and from operators. The same fault is one incident with a count; a resolved one that comes back is a regression.
      </p>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      {data && (
        data.incidents.length === 0 ? (
          <p className="mt-3 text-[13px] text-muted">No incidents.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {data.incidents.slice(0, 20).map((i) => (
              <li key={i.fingerprint} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={i.status === 'regressed' ? 'danger' : SEVERITY_TONE[i.severity]}>{i.status === 'regressed' ? 'regression' : i.severity}</Badge>
                  <span className="text-[13px] font-medium text-ink">{i.title}</span>
                  <span className="text-[12px] text-muted">{i.code} · seen {i.count}× · last {new Date(i.lastSeen).toLocaleString()} · {i.status.replace('_', ' ')}</span>
                </div>
                {i.analysis && <p className="mt-1 text-[13px] text-muted"><span className="font-medium text-ink">Cause: </span>{i.analysis.rootCause} <span className="font-medium text-ink">Fix: </span>{i.analysis.proposedChange}</p>}
                {i.fix && <a className="mt-1 inline-block text-[13px] text-ink underline" href={i.fix.pullRequestUrl} target="_blank" rel="noreferrer">Fix pull request</a>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {['open', 'regressed'].includes(i.status) && <Button size="sm" variant="secondary" disabled={busy} onClick={() => doAction(i.fingerprint, 'acknowledge')}>Acknowledge</Button>}
                  {i.status !== 'resolved' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => doAction(i.fingerprint, 'analyse')}>Ask Astra for the cause</Button>}
                  {i.status !== 'resolved' && i.status !== 'fix_proposed' && (
                    <>
                      <Input aria-label="Fix pull request URL" placeholder="https://github.com/…/pull/123" value={fixUrl[i.fingerprint] || ''} onChange={(e) => setFixUrl({ ...fixUrl, [i.fingerprint]: e.target.value })} className="min-w-0 flex-1" />
                      <Button size="sm" variant="secondary" disabled={busy || !(fixUrl[i.fingerprint] || '').trim()} onClick={() => doAction(i.fingerprint, 'propose_fix', { pullRequestUrl: fixUrl[i.fingerprint].trim() })}>Record fix</Button>
                    </>
                  )}
                  {i.status !== 'resolved' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => doAction(i.fingerprint, 'resolve')}>Resolve</Button>}
                  {i.status === 'resolved' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => doAction(i.fingerprint, 'reopen')}>Reopen</Button>}
                </div>
              </li>
            ))}
          </ul>
        )
      )}
      <form
        className="mt-4 grid max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          act(async () => {
            await development.fileIncident({ title: title.trim(), detail: detail.trim() });
            setTitle('');
            setDetail('');
          });
        }}
      >
        <Label htmlFor="inc-title">File an incident</Label>
        <Input id="inc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="What is wrong" />
        <Input aria-label="Details" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} placeholder="What you saw, where, since when" />
        <div><Button type="submit" size="sm" disabled={busy || !title.trim()}>File</Button></div>
      </form>
    </Card>
  );
}

export function KitLinkPanel() {
  const [userId, setUserId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-5">
      <h2 className="font-display text-base font-bold text-ink">Kit accounts</h2>
      <p className="mt-1 text-[13px] text-muted">A user can post only to the accounts in the publishing-provider profile linked to them here.</p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await development.kit.linkProfile(userId.trim(), profileId.trim());
            setStatus('Linked.');
            setUserId('');
            setProfileId('');
          } catch (err) {
            setStatus(err.message || 'That did not work');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div><Label htmlFor="kit-user">User id</Label><Input id="kit-user" value={userId} onChange={(e) => setUserId(e.target.value)} /></div>
        <div><Label htmlFor="kit-profile">Provider profile id</Label><Input id="kit-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} /></div>
        <Button type="submit" size="sm" disabled={busy || !userId.trim() || !profileId.trim()}>Link</Button>
      </form>
      {status && <p className="mt-2 text-[13px] text-muted" role="status">{status}</p>}
    </Card>
  );
}
