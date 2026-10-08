import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { development } from '@/lib/api';
import DevShell from './ambient/DevShell';
import { useAuth } from '@/lib/auth';
import { isAbandonedRequest } from '@/lib/development';
import { Badge, Button, Card, EmptyState, Input, Label, PageHeader, Skeleton, Switch } from '@/components/ui';
import { BattlePanel, DevDepartmentPanel, KitLinkPanel } from './Platform';

// Development operations: the operator's view of the build system.
//
// Everything here is enforced by the API (admin only); this page only makes it
// usable without a terminal. It shows why the area is or is not ready, what the
// queue and the workers are doing, lets an operator stop all new work in one
// action, and records development budget against a payment someone verified.
// It lives in the Development area rather than the marketplace admin console,
// so the two stay separate.

const REFRESH_MS = 10_000;

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md bg-surface-2/60 p-3">
      <p className="text-[12px] text-muted">{label}</p>
      <p className="mt-0.5 font-display text-xl font-bold text-ink nums">{value ?? '–'}</p>
    </div>
  );
}

function PurchaseForm({ onDone }) {
  const [userId, setUserId] = useState('');
  const [budget, setBudget] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await development.recordPurchase({ userId: userId.trim(), budget: Number(budget), paymentReference: reference.trim() });
      setResult(r);
      onDone?.();
    } catch (err) {
      setError(err.message || 'Could not record this purchase');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="ops-user">Account id</Label>
          <Input id="ops-user" value={userId} onChange={(e) => setUserId(e.target.value)} autoComplete="off" required />
        </div>
        <div>
          <Label htmlFor="ops-budget">Budget (USD)</Label>
          <Input id="ops-budget" type="number" min="1" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="ops-ref">Verified payment reference</Label>
          <Input id="ops-ref" value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" required />
        </div>
      </div>
      <p className="text-[12px] text-muted">
        Record only a payment you have seen arrive. The platform fee is added on top; recording the same reference twice credits it once.
      </p>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      {result && (
        <p className="text-[13px] text-ink nums">
          {result.replayed ? 'Already recorded — nothing changed.' : 'Recorded.'} Budget ${result.budget.toFixed(2)} + fee $
          {result.platformFee.toFixed(2)} = ${result.total.toFixed(2)} {result.currency}.
        </p>
      )}
      <Button type="submit" loading={busy} disabled={busy || !userId.trim() || !(Number(budget) > 0) || !reference.trim()}>
        Record purchase
      </Button>
    </form>
  );
}

export default function Operations() {
  const { isAdmin } = useAuth();
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      setHealth(await development.adminHealth({ signal }));
      setError(null);
    } catch (e) {
      if (isAbandonedRequest(e)) return;
      setError(e.message || 'Could not load operations');
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return undefined;
    const controller = new AbortController();
    load(controller.signal);
    const timer = setInterval(() => load(), REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [isAdmin, load]);

  if (!isAdmin) {
    return <EmptyState title="Operators only" description="This page is for RazeKit administrators." />;
  }

  const visible = Boolean(health?.visibility?.visible);
  const setVisible = async (next) => {
    setBusy(true);
    try {
      await development.setVisibility(next, reason.trim() || undefined);
      setReason('');
      await load();
    } catch (e) {
      setError(e.message || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const paused = Boolean(health?.execution?.paused);
  const setPaused = async (next) => {
    setBusy(true);
    try {
      await development.setExecution(next, reason.trim() || undefined);
      setReason('');
      await load();
    } catch (e) {
      setError(e.message || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DevShell>
    <div className="space-y-6">
      <div>
        <Link to="/development" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> All builds
        </Link>
        <PageHeader
          className="mt-2"
          eyebrow="Development"
          title="Operations"
          description="Whether builds can run on this deployment, what the workers are doing, and the controls for stopping them."
        />
      </div>

      {error && <p className="text-[13px] text-danger">{error}</p>}
      {!health && !error && <Skeleton className="h-40" />}

      {health && (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-base font-bold text-ink">Readiness</h2>
              <Badge tone={health.readiness.ready ? 'success' : 'danger'}>{health.readiness.ready ? 'Ready' : 'Not ready'}</Badge>
            </div>
            <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-4">
              {Object.entries(health.readiness.mode).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-medium text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            {health.readiness.problems.length > 0 && (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-ink">
                {health.readiness.problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-base font-bold text-ink">Public entry</h2>
            <div className="mt-3">
              <Switch
                id="ops-visible"
                checked={visible}
                busy={busy}
                disabled={busy}
                onChange={(on) => setVisible(on)}
                label={visible ? 'Visible on the public site' : 'Hidden from the public site'}
                description={
                  visible
                    ? 'Everyone sees the RazeKit DEV entry in the navigation.'
                    : 'Only administrators see the entry. Hiding removes the entry only: builds, data and workers are unaffected, and the reason below is recorded with the change.'
                }
              />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-base font-bold text-ink">Execution</h2>
            <div className="mt-3">
              <Switch
                id="ops-paused"
                checked={!paused}
                busy={busy}
                disabled={busy}
                onChange={(on) => setPaused(!on)}
                label={paused ? 'Paused: workers take no new work' : 'Running'}
                description={
                  paused
                    ? `Paused ${health.execution.at ? ago(health.execution.at) : ''}${health.execution.reason ? ` — ${health.execution.reason}` : ''}. Builds in progress finish their current step and then wait.`
                    : 'Turning this off stops every worker from starting new steps. Nothing is lost; builds resume when it is turned back on.'
                }
              />
            </div>
            <div className="mt-3 max-w-md">
              <Label htmlFor="ops-reason">Reason (recorded with the change)</Label>
              <Input id="ops-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-base font-bold text-ink">Queue</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Waiting for a worker" value={health.queue?.runnable} />
              <Stat label="Being worked on" value={health.queue?.leased} />
              <Stat label="Waiting on a person" value={health.queue?.waiting} />
              <Stat label="All builds" value={health.queue?.total} />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-base font-bold text-ink">Workers</h2>
            {health.workers.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted">No worker has ever checked in. Builds will wait until one does.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {health.workers.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-[13px]">
                    <Badge tone={w.status === 'online' ? 'success' : w.status === 'draining' ? 'warning' : 'neutral'}>{w.status}</Badge>
                    <span className="min-w-0 truncate font-mono text-[12px] text-ink">{w.id}</span>
                    <span className="text-muted">{w.capabilities.join(', ')} × {w.capacity}</span>
                    <span className="text-muted">seen {ago(w.lastHeartbeatAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-base font-bold text-ink">Models and runtime</h2>
            <ul className="mt-3 space-y-2 text-[13px]">
              {['astra', 'fable'].map((role) => {
                const p = health.providers[role];
                return (
                  <li key={role} className="flex flex-wrap items-center gap-2">
                    <Badge tone={p.available ? 'success' : 'danger'}>{p.mode}</Badge>
                    <span className="font-medium text-ink">{role === 'astra' ? 'Astra' : 'Fable'}</span>
                    <span className="text-muted">{p.vendor} · {p.model}</span>
                    {p.reason && <span className="text-danger">{p.reason}</span>}
                  </li>
                );
              })}
              <li className="flex flex-wrap items-center gap-2">
                <Badge tone={health.runtime.available ? 'success' : 'danger'}>{health.runtime.kind}</Badge>
                <span className="font-medium text-ink">Build runtime</span>
                {health.runtime.reason && <span className="text-danger">{health.runtime.reason}</span>}
              </li>
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-base font-bold text-ink">Record a verified budget purchase</h2>
            {health.funding === 'ledger' ? (
              <div className="mt-3"><PurchaseForm onDone={() => load()} /></div>
            ) : (
              <p className="mt-2 text-[13px] text-muted">This deployment does not hold development budget, so there is nothing to record.</p>
            )}
          </Card>

          <BattlePanel />
          <DevDepartmentPanel />
          <KitLinkPanel />
        </>
      )}
    </div>
    </DevShell>
  );
}
