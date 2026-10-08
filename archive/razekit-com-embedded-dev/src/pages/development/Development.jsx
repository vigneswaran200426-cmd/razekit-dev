import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppWindow, Gamepad2, Globe, Plus, Sparkles } from 'lucide-react';
import { development } from '@/lib/api';
import DevShell from './ambient/DevShell';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, EmptyState, Input, Label, PageHeader, Skeleton } from '@/components/ui';
import { isAbandonedRequest } from '@/lib/development';
import { cn } from '@/lib/cn';

// The Development area's front door.
//
// This is a RazeKit product area, not a separate console: same shell, same
// account, same visual language as Explore or Tracker. The words the user reads
// are RazeKit's own — Development, build, budget — and never the engine's
// internal vocabulary (agent instance, orchestration run, blackboard), which
// describes machinery the user did not ask about.

const TASK_TYPES = [
  { key: 'website', label: 'Website', icon: Globe, blurb: 'A marketing site, a landing page, a portfolio.' },
  { key: 'app', label: 'App', icon: AppWindow, blurb: 'A web app with screens, state and logic.' },
  { key: 'game', label: 'Game', icon: Gamepad2, blurb: 'A playable game built and packaged for you.' },
];

const STATUS_TONE = {
  completed: 'success',
  running: 'primary',
  queued: 'primary',
  ready_for_agent: 'primary',
  waiting_user: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

function statusLabel(status) {
  if (status === 'waiting_user') return 'Needs you';
  if (status === 'ready_for_agent' || status === 'queued') return 'Starting';
  return String(status || '').replace(/_/g, ' ');
}

function TaskRow({ task }) {
  const type = TASK_TYPES.find((t) => t.key === task.taskType);
  const Icon = type?.icon || Sparkles;
  const spent = Number(task.actualSpend || 0);
  const limit = Number(task.maxBudget || 0);

  return (
    <Card hover as={Link} to={`/development/${task.id}`} className="flex items-center gap-4 p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-surface-2 text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">{task.title}</p>
        <p className="truncate text-[13px] text-muted">{task.originalRequest}</p>
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <p className="text-[12px] text-muted nums">
          ${spent.toFixed(2)} of ${limit.toFixed(2)}
        </p>
      </div>
      <Badge tone={STATUS_TONE[task.status] || 'neutral'}>{statusLabel(task.status)}</Badge>
    </Card>
  );
}

function NewTaskForm({ onCreated }) {
  const [taskType, setTaskType] = useState('website');
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [maxBudget, setMaxBudget] = useState('');
  const [authorised, setAuthorised] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [balance, setBalance] = useState(null);
  // One key per form: a double-clicked "Start build" is one build, not two.
  const [idempotencyKey] = useState(() => `start-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);

  // On deployments that hold development budget, show what is available, so
  // the limit the user sets is one they can actually fund.
  useEffect(() => {
    const controller = new AbortController();
    development.budget({ signal: controller.signal })
      .then((b) => setBalance(b?.mode === 'ledger' ? b : null))
      .catch(() => setBalance(null));
    return () => controller.abort();
  }, []);

  // The pre-flight is advisory and creates nothing. It exists so the budget the
  // user commits to is an informed number rather than a guess.
  const analyze = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await development.analyze({ taskType, title, originalRequest: request });
      setPreflight(result);
      if (!maxBudget) setMaxBudget(String(result.estimatedBudget));
    } catch (e) {
      setError(e.message || 'Could not analyse this request');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const created = await development.create({
        taskType,
        title: title.trim() || 'Untitled build',
        originalRequest: request.trim(),
        maxBudget: Number(maxBudget),
        acceptAutonomousExecution: authorised,
        acceptanceCriteria: [],
      }, { idempotencyKey });
      onCreated(created.task);
    } catch (e) {
      setError(e.message || 'Could not start this build');
    } finally {
      setBusy(false);
    }
  };

  const ready = request.trim().length > 0 && Number(maxBudget) > 0 && authorised;

  return (
    <Card className="p-5">
      <h2 className="font-display text-base font-bold text-ink">Start a build</h2>
      <p className="mt-1 text-[13px] text-muted">Describe what you want. RazeKit builds, tests and packages it.</p>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {TASK_TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={taskType === t.key}
            onClick={() => { setTaskType(t.key); setPreflight(null); }}
            className={cn(
              'rounded-md border p-3 text-left transition-colors',
              taskType === t.key
                ? 'border-primary bg-primary/5'
                : 'border-line hover:border-line-strong hover:bg-surface-2',
            )}
          >
            <t.icon className={cn('h-4 w-4', taskType === t.key ? 'text-primary' : 'text-muted')} />
            <p className="mt-1.5 text-sm font-semibold text-ink">{t.label}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">{t.blurb}</p>
          </button>
        ))}
      </div>

      <div className="mt-4">
        <Label htmlFor="dev-title">Name</Label>
        <Input id="dev-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Landing page for the beta" />
      </div>

      <div className="mt-3">
        <Label htmlFor="dev-request">What should it do?</Label>
        <textarea
          id="dev-request"
          value={request}
          onChange={(e) => { setRequest(e.target.value); setPreflight(null); }}
          rows={4}
          placeholder="A responsive landing page with a navigation bar, hero section, call to action and footer."
          className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {preflight && (
        <div className="mt-3 rounded-md border border-line bg-surface-2/60 p-3">
          <p className="text-[13px] text-ink">
            Looks <strong>{preflight.complexity}</strong> complexity. Estimated cost{' '}
            <strong className="nums">${preflight.estimatedBudget}</strong>.
          </p>
          {preflight.externalServices?.length > 0 && (
            <p className="mt-1 text-[12px] text-muted">
              May need: {preflight.externalServices.join(', ')}. You will be asked before anything external is used.
            </p>
          )}
        </div>
      )}

      <div className="mt-3">
        <Label htmlFor="dev-budget">Maximum you want to spend (USD)</Label>
        <Input
          id="dev-budget"
          type="number"
          min="1"
          step="1"
          value={maxBudget}
          onChange={(e) => setMaxBudget(e.target.value)}
          placeholder="25"
        />
        {/* Stated plainly because it is enforced, not advisory: the build stops
            at this number and asks, rather than quietly continuing to spend. */}
        <p className="mt-1 text-[12px] text-muted">This is a hard limit. The build stops and asks you before going past it.</p>
        {balance && (
          <p className="mt-1 text-[12px] text-muted nums">
            Available development budget: ${Number(balance.available).toFixed(2)}
            {balance.credit > 0 && ` (including $${Number(balance.credit).toFixed(2)} of credit from earlier builds)`}
          </p>
        )}
      </div>

      <label className="mt-3 flex items-start gap-2.5 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={authorised}
          onChange={(e) => setAuthorised(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-line-strong text-primary focus:ring-primary/30"
        />
        <span>
          I authorise RazeKit to write code, run tests and build this on its own, inside an isolated workspace.
        </span>
      </label>

      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={analyze} loading={busy && !ready} disabled={!request.trim() || busy}>
          Estimate first
        </Button>
        <Button onClick={create} loading={busy && ready} disabled={!ready || busy}>
          Start build
        </Button>
      </div>
    </Card>
  );
}

export default function Development() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [tasks, setTasks] = useState(null);
  const [configured, setConfigured] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (signal) => {
    try {
      const status = await development.status({ signal });
      setConfigured(status.configured);
      if (!status.configured) { setTasks([]); return; }
      setTasks(await development.list({ signal }));
    } catch (e) {
      if (isAbandonedRequest(e)) return;
      setError(e.message || 'Could not load your builds');
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <DevShell>
    <div className="space-y-6">
      <PageHeader
        eyebrow="Development"
        title="Builds"
        description="Describe an app, a website or a game. RazeKit plans it, builds it, tests it and shows you the result."
        actions={
          <>
            <Button to="/development/kit" variant="secondary">Kit</Button>
            {isAdmin && (
              <Button to="/development/ops" variant="secondary">Operations</Button>
            )}
            {configured && !creating && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New build
              </Button>
            )}
          </>
        }
      />

      {configured === false && (
        <EmptyState
          icon={Sparkles}
          title="Development is not switched on for this deployment"
          description="The autonomous build engine has not been configured yet. Everything else in RazeKit works as usual."
        />
      )}

      {error && <p className="text-[13px] text-danger">{error}</p>}

      {creating && <NewTaskForm onCreated={(task) => navigate(`/development/${task.id}`)} />}

      {tasks === null && (
        <div className="space-y-3">
          <Skeleton className="h-[74px]" />
          <Skeleton className="h-[74px]" />
        </div>
      )}

      {tasks?.length > 0 && (
        <div className="space-y-3">
          {tasks.map((task) => <TaskRow key={task.id} task={task} />)}
        </div>
      )}

      {configured && tasks?.length === 0 && !creating && (
        <EmptyState
          icon={Sparkles}
          title="No builds yet"
          description="Start one and watch it get planned, written, tested and packaged."
          action={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New build</Button>}
        />
      )}
    </div>
    </DevShell>
  );
}
