import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, Ban, CheckCircle2, Clock, Download, Loader2, Package, Send, ShieldCheck, Square,
} from 'lucide-react';
import { development } from '@/lib/api';
import DevShell from './ambient/DevShell';
import Assistant from './ambient/Assistant';
import { Badge, Button, Card, Input, Spinner } from '@/components/ui';
import { isAbandonedRequest } from '@/lib/development';
import { cn } from '@/lib/cn';

// The Control Center for one build.
//
// The engine knows a great deal that the user does not want: which tool was
// invoked, which step retried, which model session spent what. The dashboard
// projection it returns has already dropped that noise, and this screen renders
// the projection rather than re-deriving anything — so "what the user sees" and
// "what the backend believes" cannot drift apart. Every value on this page is
// persisted server state; nothing here animates to suggest progress that is not
// actually happening.

const REFRESH_MS = 5000;

const STATUS_STYLE = {
  WORKING: { tone: 'primary', icon: Loader2, spin: true, help: 'RazeKit is building this now.' },
  'DECISION NEEDED': { tone: 'warning', icon: AlertTriangle, help: 'This needs an answer from you before it can carry on.' },
  'IMPORTANT UPDATE': { tone: 'primary', icon: Clock, help: 'Something changed that is worth knowing about.' },
  BLOCKED: { tone: 'danger', icon: Ban, help: 'This has stopped and cannot continue on its own.' },
  COMPLETED: { tone: 'success', icon: CheckCircle2, help: 'Built, tested and verified.' },
  STOPPED: { tone: 'neutral', icon: Square, help: 'This build was stopped. Anything unspent was not charged.' },
};

// A build in one of these states will not change on its own, so there is
// nothing to poll for.
const SETTLED = new Set(['COMPLETED', 'BLOCKED', 'STOPPED']);

function StatusBanner({ status }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.WORKING;
  const Icon = style.icon;
  return (
    <Card className="flex items-center gap-3 p-4">
      <span
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-md',
          style.tone === 'success' && 'bg-success/10 text-success',
          style.tone === 'warning' && 'bg-warning/12 text-warning',
          style.tone === 'danger' && 'bg-danger/10 text-danger',
          style.tone === 'primary' && 'bg-primary/10 text-primary',
          style.tone === 'neutral' && 'bg-surface-2 text-muted',
        )}
      >
        <Icon className={cn('h-5 w-5', style.spin && 'animate-spin motion-reduce:animate-none')} />
      </span>
      <div className="min-w-0">
        <p className="font-display text-base font-bold text-ink">{status}</p>
        <p className="text-[13px] text-muted">{style.help}</p>
      </div>
    </Card>
  );
}

function Progress({ progress, budget }) {
  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
  const spentPercent = Math.max(0, Math.min(100, Number(budget?.percentUsed || 0)));

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-[13px] font-medium text-ink">Progress</p>
        <p className="text-[13px] text-muted nums">{percent}%</p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar"
        aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Build progress">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      {progress?.steps?.total > 0 && (
        <p className="mt-1.5 text-[12px] text-muted nums">
          {progress.steps.passed} of {progress.steps.total} steps done
          {progress.steps.failed > 0 && ` · ${progress.steps.failed} failed`}
        </p>
      )}

      <div className="mt-4 flex items-baseline justify-between">
        <p className="text-[13px] font-medium text-ink">Spend</p>
        <p className="text-[13px] text-muted nums">
          ${Number(budget?.currentSpend || 0).toFixed(2)} of ${Number(budget?.maxBudget || 0).toFixed(2)}
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', spentPercent >= 90 ? 'bg-warning' : 'bg-ink/60')}
          style={{ width: `${spentPercent}%` }}
        />
      </div>
    </Card>
  );
}

function Decision({ change, onApprove, onDeny, busy }) {
  const snapshot = change.budgetSnapshot || {};
  const needsMore = snapshot.withinBudget === false;
  const [budget, setBudget] = useState(String(Math.ceil(Number(snapshot.projectedSpend || 0)) || ''));

  return (
    <Card className="border-warning/40 p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          {/* A decision is either something the user asked for that needs a
              yes, or a question the build stopped to ask. Worded as such. */}
          <p className="text-sm font-semibold text-ink">
            {change.origin === 'build' ? change.content : <>You asked for: “{change.content}”</>}
          </p>
          <p className="mt-1 text-[13px] text-muted">{change.reason}</p>

          {needsMore && (
            <div className="mt-3">
              {/* Approving a change that costs more than the remaining budget
                  would silently raise the ceiling the user set. It is raised
                  here, explicitly, or not at all. */}
              <label className="block text-[12px] font-medium text-ink" htmlFor={`budget-${change.id}`}>
                This needs a higher limit to go ahead (USD)
              </label>
              <Input
                id={`budget-${change.id}`}
                type="number"
                min="1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="mt-1 max-w-[180px]"
              />
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => onApprove(change.id, needsMore ? Number(budget) : null)}>
              Approve
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDeny(change.id)}>
              No thanks
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function BuildDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [acceptance, setAcceptance] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [repo, setRepo] = useState('');
  const chatEndRef = useRef(null);

  const load = useCallback(
    async (signal) => {
      try {
        const [dashboard, criteria] = await Promise.all([
          development.dashboard(id, { signal }),
          development.acceptance(id, { signal }).catch(() => []),
        ]);
        setData(dashboard);
        setAcceptance(criteria || []);
        setError(null);
      } catch (e) {
        if (isAbandonedRequest(e)) return;
        setError(e.message || 'Could not load this build');
      }
    },
    [id],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Polls while there is something to watch. A finished or stopped build does
  // not need a request every five seconds for as long as the tab is open.
  useEffect(() => {
    if (SETTLED.has(data?.status)) return undefined;
    const timer = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [data?.status, load]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [data?.chat?.length]);

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const send = async (e) => {
    e.preventDefault();
    const content = message.trim();
    if (!content) return;
    setMessage('');
    await act(() => development.command(id, content));
  };

  if (!data) {
    return (
      <div className="flex items-center gap-3 py-16 text-muted">
        <Spinner /> <span className="text-sm">Loading this build…</span>
      </div>
    );
  }

  const completed = data.status === 'COMPLETED';
  const settled = SETTLED.has(data.status);

  const deliver = () => act(async () => {
    const repository = (repo || '').trim();
    if (!repository) return;
    await development.deliver(id, repository);
  });

  // What the assistant says comes only from this build's recorded state.
  const decision = data.pendingDecisions?.[0];
  const moment = decision
    ? {
        key: `${id}:decision:${decision.id}`,
        kind: 'decision',
        title: decision.origin === 'build' ? 'The build needs your decision' : 'Your change needs a decision',
        message: decision.content,
        actions: [{ label: 'Go to the decision', primary: true, dismiss: false, onClick: () => document.getElementById('dev-decisions')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }],
      }
    : data.failure
      ? { key: `${id}:failed`, kind: 'error', title: 'The build stopped', message: data.failure.message, actions: [] }
      : completed
        ? {
            key: `${id}:completed`,
            kind: 'completion',
            title: 'Built, tested and verified',
            message: `${(data.verification?.checks ?? []).filter((c) => c.passed).length} checks passed.${data.delivery ? ` Delivered to ${data.delivery.repository} as a draft pull request.` : ' It is ready to download.'}`,
            actions: data.artifact ? [{ label: 'Download', primary: true, onClick: () => download() }] : [],
          }
        : null;
  const activity = decision || data.failure ? 'alert' : settled ? 'idle' : 'active';

  const download = () => act(async () => {
    const { url } = await development.artifact(id);
    window.location.assign(url);
  });

  return (
    <DevShell activity={activity}>
    <Assistant moment={moment} />
    <div className="space-y-6">
      <div>
        <Link to="/development" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> All builds
        </Link>
        <h1 className="mt-2 font-display text-2xl font-extrabold tracking-tight text-ink">{data.task.title}</h1>
        <p className="mt-1 text-[13px] text-muted">
          {data.task.taskType === 'game' ? 'Game' : data.task.taskType === 'app' ? 'App' : 'Website'}
        </p>
      </div>

      <StatusBanner status={data.status} />

      {error && <p className="text-[13px] text-danger">{error}</p>}

      {data.failure && (
        <Card className="border-danger/30 p-4">
          <p className="text-sm font-semibold text-ink">Why it stopped</p>
          <p className="mt-1 break-words text-[13px] text-muted">{data.failure.message}</p>
        </Card>
      )}

      <div id="dev-decisions" />
      {data.pendingDecisions?.map((change) => (
        <Decision
          key={change.id}
          change={change}
          busy={busy}
          onApprove={(changeId, maxBudget) => act(() => development.approveChange(id, changeId, maxBudget))}
          onDeny={(changeId) => act(() => development.denyChange(id, changeId, 'Not wanted'))}
        />
      ))}

      {/* min-w-0 on both columns: a grid item defaults to min-width:auto, so it
          refuses to shrink below its content's intrinsic width. A long
          deliverable path or an unbroken chat message would then push the
          whole page wider than a phone screen. */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          {/* Chat is the control surface: the user talks to the build, and the
              build answers. Tool calls and test output are filtered out
              server-side, so this stays a conversation rather than a log. */}
          <Card className="flex flex-col p-4">
            <p className="text-[13px] font-medium text-ink">Conversation</p>
            <div className="mt-3 max-h-[420px] min-h-[160px] space-y-2.5 overflow-y-auto pr-1">
              {data.chat?.length ? (
                data.chat.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      // break-words because a message can carry a path, a URL or
                      // an error string with no space in it to wrap at.
                      'max-w-[85%] break-words rounded-lg px-3 py-2 text-[13px] leading-relaxed',
                      m.role === 'user'
                        ? 'ml-auto bg-primary/10 text-ink'
                        : m.role === 'system'
                          ? 'bg-surface-2 text-muted'
                          : 'bg-surface-2 text-ink',
                    )}
                  >
                    {m.content}
                  </div>
                ))
              ) : (
                <p className="text-[13px] text-muted">Nothing yet. Ask for a change and it will show up here.</p>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={send} className="mt-3 flex gap-2">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={settled ? 'This build is finished' : 'Change the hero to dark blue…'}
                disabled={busy || settled}
                aria-label="Ask for a change"
              />
              <Button type="submit" size="md" disabled={busy || settled || !message.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </Card>

          {data.events?.length > 0 && (
            <Card className="p-4">
              <p className="text-[13px] font-medium text-ink">Updates</p>
              <ul className="mt-2.5 space-y-2.5">
                {data.events.slice(0, 8).map((event) => (
                  <li key={event.id} className="flex gap-2.5">
                    <Badge tone={STATUS_STYLE[event.status]?.tone || 'neutral'}>{event.status}</Badge>
                    <div className="min-w-0">
                      <p className="text-[13px] text-ink">{event.title}</p>
                      <p className="truncate text-[12px] text-muted">{event.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <Progress progress={data.progress} budget={data.budget} />

          {/* Verification is shown as its own fact, separate from progress: a
              build is not finished because it says so, it is finished because
              it was checked. */}
          <Card className="p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className={cn('h-4 w-4', data.verification?.status === 'passed' ? 'text-success' : 'text-muted')} />
              <p className="text-[13px] font-medium text-ink">Verification</p>
            </div>
            <p className="mt-1.5 text-[13px] text-muted">
              {data.verification?.status === 'passed'
                ? 'Checked: tests, build and deliverables all confirmed.'
                : data.verification?.status === 'failed'
                  ? 'Checks did not pass yet.'
                  : 'Not checked yet.'}
            </p>
            {data.verification?.failures?.length > 0 && (
              <ul className="mt-2 space-y-1">
                {data.verification.failures.map((f, i) => (
                  <li key={i} className="text-[12px] text-danger">{f.reason}</li>
                ))}
              </ul>
            )}
          </Card>

          {acceptance.length > 0 && (
            <Card className="p-4">
              <p className="text-[13px] font-medium text-ink">What “done” means</p>
              <ul className="mt-2 space-y-1.5">
                {acceptance.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-[13px]">
                    <CheckCircle2
                      className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', c.status === 'passed' ? 'text-success' : 'text-subtle')}
                    />
                    <span className={c.status === 'passed' ? 'text-ink' : 'text-muted'}>{c.text}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.deliverables?.length > 0 && (
            <Card className="p-4">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted" />
                <p className="text-[13px] font-medium text-ink">Deliverables</p>
              </div>
              <ul className="mt-2 space-y-1">
                {data.deliverables.slice(0, 12).map((d, i) => (
                  <li key={i} className="truncate font-mono text-[12px] text-muted">{d.path}</li>
                ))}
              </ul>
              {completed && data.artifact && (
                <Button variant="secondary" size="sm" className="mt-3 w-full" disabled={busy} onClick={download}>
                  <Download className="h-4 w-4" /> Download ({Math.max(1, Math.round(data.artifact.bytes / 1024))} KB)
                </Button>
              )}
              {completed && data.delivery && (
                <p className="mt-3 text-[13px] text-muted">
                  Delivered to {data.delivery.repository}:{' '}
                  <a className="font-medium text-ink underline" href={data.delivery.pullRequest.url} target="_blank" rel="noreferrer">
                    draft pull request #{data.delivery.pullRequest.number}
                  </a>
                </p>
              )}
              {completed && !data.delivery && (
                <div className="mt-3 flex gap-2">
                  <input
                    aria-label="GitHub repository (owner/name)"
                    placeholder="owner/repository"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 font-mono text-[12px] text-ink"
                  />
                  <Button variant="secondary" size="sm" disabled={busy || !repo.trim()} onClick={deliver}>
                    Deliver to GitHub
                  </Button>
                </div>
              )}
            </Card>
          )}

          {!settled && (
            <Button
              variant="outlineDanger"
              className="w-full"
              disabled={busy}
              onClick={() => act(() => development.cancel(id))}
            >
              Stop this build
            </Button>
          )}
        </div>
      </div>
    </div>
    </DevShell>
  );
}
