import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Image as ImageIcon, RefreshCw, Send } from 'lucide-react';
import { development } from '@/lib/api';
import DevShell from './ambient/DevShell';
import { isAbandonedRequest } from '@/lib/development';
import { Badge, Button, Card, EmptyState, Input, Label, PageHeader, Skeleton } from '@/components/ui';

// Kit: write once, adapt per platform, schedule, publish, and follow the
// provider's word on what happened. Every status and link on this page comes
// from the provider through the API; Kit shows no likes, views or follower
// counts, because it has none it could stand behind.

const LIMITS = { twitter: 280, threads: 500, bluesky: 300, instagram: 2200, tiktok: 2200, linkedin: 3000, facebook: 63206, youtube: 5000, pinterest: 500, reddit: 40000, telegram: 4096, googlebusiness: 1500, snapchat: 250, whatsapp: 4096 };
const TONE = { draft: 'neutral', scheduled: 'primary', publishing: 'warning', published: 'success', partial: 'warning', failed: 'danger', cancelled: 'neutral', unknown: 'danger' };
const LABEL = { unknown: 'outcome unknown' };

function Composer({ accounts, onSaved }) {
  const [content, setContent] = useState('');
  const [media, setMedia] = useState('');
  const [chosen, setChosen] = useState({});
  const [variants, setVariants] = useState({});
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const targets = accounts
    .filter((a) => chosen[a.id])
    .map((a) => ({ platform: a.platform, accountId: a.id, content: variants[a.id]?.trim() ? variants[a.id] : undefined }));

  const submit = async (publish) => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        content,
        mediaUrls: media.split(/\s+/).map((s) => s.trim()).filter(Boolean),
        targets,
        publishNow: !when,
        ...(when ? { scheduledFor: new Date(when).toISOString() } : {}),
      };
      const { post, problems } = await development.kit.create(body);
      if (problems.length) throw new Error(problems.join(' '));
      if (publish) await development.kit.submit(post.id);
      setContent('');
      setMedia('');
      setChosen({});
      setVariants({});
      setWhen('');
      onSaved();
    } catch (e) {
      setError(e.message || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <Label htmlFor="kit-content">Master post</Label>
      <textarea
        id="kit-content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={4}
        className="mt-1 w-full rounded-lg border border-line bg-white p-3 text-[14px] text-ink"
        placeholder="Write it once; adapt it per platform below."
      />
      <div className="mt-2 flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-muted" aria-hidden="true" />
        <Input aria-label="Media URLs (https, space separated)" value={media} onChange={(e) => setMedia(e.target.value)} placeholder="https://… media URLs, space separated" />
      </div>

      <p className="mt-4 text-[13px] font-medium text-ink">Where</p>
      <ul className="mt-2 space-y-3">
        {accounts.map((a) => {
          const limit = LIMITS[a.platform];
          const text = variants[a.id]?.trim() ? variants[a.id] : content;
          const over = limit && text.length > limit;
          return (
            <li key={a.id} className="rounded-md border border-line p-3">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="checkbox" checked={Boolean(chosen[a.id])} disabled={!a.active || a.needsReconnection} onChange={(e) => setChosen({ ...chosen, [a.id]: e.target.checked })} />
                <span className="font-medium">{a.platform}</span>
                <span className="text-muted">{a.displayName || a.username || a.id}</span>
                {(a.needsReconnection || !a.active) && <Badge tone="danger">reconnect at the provider</Badge>}
              </label>
              {chosen[a.id] && (
                <div className="mt-2">
                  <textarea
                    aria-label={`${a.platform} version`}
                    value={variants[a.id] ?? ''}
                    onChange={(e) => setVariants({ ...variants, [a.id]: e.target.value })}
                    rows={2}
                    className="w-full rounded-lg border border-line bg-white p-2 text-[13px] text-ink"
                    placeholder="Leave empty to use the master post"
                  />
                  {limit && <p className={over ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>{text.length} / {limit}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="kit-when">Schedule (optional)</Label>
          <Input id="kit-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <Button disabled={busy || !content.trim() || !targets.length} onClick={() => submit(true)}>
          <Send className="h-4 w-4" /> {when ? 'Schedule' : 'Publish'}
        </Button>
        <Button variant="secondary" disabled={busy || !content.trim()} onClick={() => submit(false)}>Save draft</Button>
      </div>
      {error && <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p>}
    </Card>
  );
}

export default function KitPage() {
  const [accounts, setAccounts] = useState(null);
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      const [a, p] = await Promise.all([development.kit.accounts({ signal }), development.kit.posts({ signal })]);
      setAccounts(a);
      setPosts(p.posts);
      setError(null);
    } catch (e) {
      if (!isAbandonedRequest(e)) setError(e.message || 'Could not load Kit');
    }
  }, []);
  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

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

  const sorted = useMemo(() => (posts ?? []).slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), [posts]);

  return (
    <DevShell>
    <div className="space-y-6">
      <div>
        <Link to="/development" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> Builds
        </Link>
        <PageHeader eyebrow="Development" title="Kit" description="Write once, adapt per platform, schedule, publish — and see exactly what the platforms confirmed." />
      </div>
      {error && <p className="text-[13px] text-danger" role="alert">{error}</p>}
      {!accounts && !error && <Skeleton className="h-40" />}
      {accounts && !accounts.configured && <EmptyState title="Kit is not set up" description="Publishing is not configured on this deployment." />}
      {accounts?.configured && !accounts.linked && (
        <EmptyState title="No accounts linked to you yet" description="An administrator links your social accounts to Kit. Once linked, they appear here." />
      )}
      {accounts?.configured && accounts.linked && accounts.accounts.length === 0 && (
        <EmptyState title="No connected accounts" description="Connect social accounts at the publishing provider, then refresh." />
      )}
      {accounts?.configured && accounts.accounts.length > 0 && <Composer accounts={accounts.accounts} onSaved={() => load()} />}

      {sorted.length > 0 && (
        <section aria-label="Posts" className="space-y-3">
          {sorted.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TONE[p.status] || 'neutral'}>{LABEL[p.status] || p.status}</Badge>
                <span className="text-[12px] text-muted">{p.scheduledFor ? `for ${new Date(p.scheduledFor).toLocaleString()}` : new Date(p.updatedAt).toLocaleString()}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[14px] text-ink">{p.content}</p>
              {p.mediaUrls.length > 0 && <p className="mt-1 text-[12px] text-muted">{p.mediaUrls.length} media item(s)</p>}
              <ul className="mt-2 space-y-1">
                {(p.platforms.length ? p.platforms : p.targets.map((t) => ({ ...t, status: 'not sent', url: null, error: null }))).map((t) => (
                  <li key={`${t.platform}-${t.accountId}`} className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                    <span className="font-medium text-ink">{t.platform}</span> {t.status}
                    {t.url && <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink underline">view <ExternalLink className="h-3 w-3" /></a>}
                    {t.error && <span className="text-danger">{t.error}</span>}
                  </li>
                ))}
              </ul>
              {p.lastError && p.status !== 'published' && <p className="mt-1 text-[13px] text-danger">{p.lastError}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {p.status === 'draft' && <Button size="sm" disabled={busy} onClick={() => act(() => development.kit.submit(p.id))}>Submit</Button>}
                {p.status === 'draft' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => development.kit.cancel(p.id))}>Cancel</Button>}
                {['scheduled', 'publishing', 'partial', 'unknown'].includes(p.status) && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => development.kit.refresh(p.id))}><RefreshCw className="h-3.5 w-3.5" /> Check status</Button>
                )}
                {p.status === 'unknown' && <Button size="sm" variant="outlineDanger" disabled={busy} onClick={() => act(() => development.kit.abandon(p.id))}>It did not go out</Button>}
              </div>
            </Card>
          ))}
        </section>
      )}
    </div>
    </DevShell>
  );
}
