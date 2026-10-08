// Kit: one piece of content, adapted per platform, scheduled and published
// through the provider, and tracked until the provider confirms it.
//
//   DRAFT → REVIEW → SUBMIT → SCHEDULED / PUBLISHING → PUBLISHED | PARTIAL | FAILED
//
// Rules that do not bend:
//   • A post is published only when the provider says so. Kit keeps the
//     provider's own status and links; it never shows a count, a like or a
//     view it did not get from the provider — and it asks for none.
//   • Who may post where: the platform has one provider key, so every
//     connected account belongs to RazeKit's provider workspace. A user may
//     post only to accounts in the provider profile an administrator linked
//     to them; administrators may use any. Checked again at submit.
//   • Submitting is idempotent: each Kit post carries one request id, which
//     the provider treats as the same post for about five minutes. If the
//     answer is lost the post is UNKNOWN — never silently resubmitted after
//     that window; a person decides.
import { randomUUID } from 'node:crypto';
import { DevError, ERR, notFound, validation } from '../engine/errors.js';
import { tenantIdFor } from '../engine/task.js';
import type { DevStore } from '../store/types.js';
import type { ProviderPost, SocialAccount, SocialProvider } from './zernio.js';

export const PLATFORM_LIMITS: Record<string, number> = {
  twitter: 280, threads: 500, bluesky: 300, instagram: 2200, tiktok: 2200, linkedin: 3000, facebook: 63206,
  youtube: 5000, pinterest: 500, reddit: 40000, telegram: 4096, googlebusiness: 1500, snapchat: 250, whatsapp: 4096,
};
const RECONCILE_WINDOW_MS = 4.5 * 60_000;

export type KitStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled' | 'unknown';

export interface KitPost {
  id: string;
  tenantId: string;
  userId: string;
  content: string;
  mediaUrls: string[];
  targets: { platform: string; accountId: string; content: string | null }[];
  publishNow: boolean;
  scheduledFor: string | null;
  status: KitStatus;
  requestId: string;
  submittedAt: string | null;
  providerPostId: string | null;
  platforms: ProviderPost['platforms'];
  lastError: string | null;
  history: { at: string; event: string; note: string }[];
  createdAt: string;
  updatedAt: string;
}

interface Caller {
  id: string;
  role?: string;
}

const kindFor = (tenantId: string) => `kit-post:${tenantId}`;
const profileKey = (tenantId: string) => `kit-profile:${tenantId}`;

export class Kit {
  constructor(private deps: { store: DevStore; provider: SocialProvider; now?: () => Date }) {}

  private iso() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The accounts this caller may post to. */
  private async allowed(caller: Caller): Promise<{ accounts: SocialAccount[]; linked: boolean }> {
    const all = await this.deps.provider.listAccounts();
    if (caller.role === 'admin') return { accounts: all, linked: true };
    const link = await this.deps.store.getControl<{ profileId: string }>(profileKey(tenantIdFor({ id: caller.id })));
    if (!link) return { accounts: [], linked: false };
    return { accounts: all.filter((a) => a.profileId === link.profileId), linked: true };
  }

  async accounts(caller: Caller) {
    if (!this.deps.provider.configured) return { configured: false, linked: false, accounts: [] };
    const { accounts, linked } = await this.allowed(caller);
    return { configured: true, linked, accounts };
  }

  async linkProfile(admin: Caller, userId: unknown, profileId: unknown) {
    if (typeof userId !== 'string' || !userId.trim() || typeof profileId !== 'string' || !profileId.trim()) throw validation('Give a user id and a provider profile id.');
    const value = { profileId: profileId.trim(), by: admin.id, at: this.iso() };
    await this.deps.store.setControl(profileKey(tenantIdFor({ id: userId.trim() })), value);
    return value;
  }

  async list(caller: Caller) {
    const rs = await this.deps.store.listRecords<KitPost>(kindFor(tenantIdFor({ id: caller.id })), { limit: 100 });
    return { posts: rs.map((r) => r.data) };
  }

  private async get(caller: Caller, id: string): Promise<KitPost> {
    const rec = await this.deps.store.getRecord<KitPost>(kindFor(tenantIdFor({ id: caller.id })), id);
    if (!rec) throw notFound('Post');
    return rec.data;
  }

  private async save(post: KitPost, event: string, note = '') {
    post.updatedAt = this.iso();
    post.history = [...post.history, { at: post.updatedAt, event, note: note.slice(0, 500) }].slice(-50);
    await this.deps.store.putRecord(kindFor(post.tenantId), post.id, post);
    return post;
  }

  private parse(input: any, base?: KitPost) {
    const content = typeof input?.content === 'string' ? input.content : base?.content ?? '';
    if (!content.trim() || content.length > 63_206) throw validation('The post needs content (up to 63206 characters).');
    const mediaUrls = input?.mediaUrls !== undefined ? input.mediaUrls : base?.mediaUrls ?? [];
    if (!Array.isArray(mediaUrls) || mediaUrls.length > 10 || !mediaUrls.every((u: unknown) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u))) {
      throw validation('Media must be up to 10 https URLs.');
    }
    const targets = input?.targets !== undefined ? input.targets : base?.targets ?? [];
    if (!Array.isArray(targets) || targets.length > 20) throw validation('Choose up to 20 accounts.');
    const clean = targets.map((t: any) => {
      if (typeof t?.platform !== 'string' || typeof t?.accountId !== 'string') throw validation('Each target needs a platform and an account.');
      return { platform: t.platform, accountId: t.accountId, content: typeof t.content === 'string' && t.content.trim() ? t.content : null };
    });
    const publishNow = input?.publishNow !== undefined ? input.publishNow === true : base?.publishNow ?? true;
    const scheduledFor = publishNow ? null : typeof input?.scheduledFor === 'string' ? input.scheduledFor : base?.scheduledFor ?? null;
    if (!publishNow && (!scheduledFor || Number.isNaN(Date.parse(scheduledFor)))) throw validation('A scheduled post needs a valid time.');
    return { content, mediaUrls, targets: clean, publishNow, scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null };
  }

  /** What would stop this post from going out, per platform. Empty when ready. */
  review(post: Pick<KitPost, 'content' | 'targets' | 'publishNow' | 'scheduledFor'>, now = Date.now()): string[] {
    const problems: string[] = [];
    if (!post.targets.length) problems.push('Choose at least one account.');
    for (const t of post.targets) {
      const text = t.content ?? post.content;
      const limit = PLATFORM_LIMITS[t.platform];
      if (limit && text.length > limit) problems.push(`${t.platform}: ${text.length} characters, over its ${limit} limit.`);
    }
    if (!post.publishNow && post.scheduledFor && Date.parse(post.scheduledFor) < now + 60_000) problems.push('The scheduled time must be at least a minute from now.');
    return problems;
  }

  async create(caller: Caller, input: any) {
    const at = this.iso();
    const post: KitPost = {
      id: `kit_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      tenantId: tenantIdFor({ id: caller.id }),
      userId: caller.id,
      ...this.parse(input),
      status: 'draft',
      requestId: randomUUID(),
      submittedAt: null,
      providerPostId: null,
      platforms: [],
      lastError: null,
      history: [],
      createdAt: at,
      updatedAt: at,
    };
    return { post: await this.save(post, 'drafted'), problems: this.review(post) };
  }

  async update(caller: Caller, id: string, input: any) {
    const post = await this.get(caller, id);
    if (post.status !== 'draft') throw new DevError(ERR.STATE, 'Only a draft can be edited.', { httpStatus: 409 });
    Object.assign(post, this.parse(input, post));
    return { post: await this.save(post, 'edited'), problems: this.review(post) };
  }

  async submit(caller: Caller, id: string) {
    const post = await this.get(caller, id);
    if (post.status !== 'draft') throw new DevError(ERR.STATE, `A ${post.status} post cannot be submitted.`, { httpStatus: 409 });
    const problems = this.review(post);
    if (problems.length) throw validation(problems.join(' '));
    // Authority is checked now, not when the draft was written.
    const { accounts } = await this.allowed(caller);
    const allowed = new Map(accounts.map((a) => [a.id, a]));
    for (const t of post.targets) {
      const a = allowed.get(t.accountId);
      if (!a || a.platform !== t.platform) throw new DevError(ERR.AUTHORIZATION_REQUIRED, `You may not post to that ${t.platform} account.`, { httpStatus: 403 });
      if (!a.active || a.needsReconnection) throw validation(`The ${t.platform} account needs to be reconnected at the provider first.`);
    }
    post.submittedAt ??= this.iso();
    return this.send(post, 'submitted');
  }

  private async send(post: KitPost, event: string) {
    try {
      const out = await this.deps.provider.publish({
        content: post.content,
        mediaUrls: post.mediaUrls,
        targets: post.targets,
        publishNow: post.publishNow,
        scheduledFor: post.scheduledFor,
        requestId: post.requestId,
      });
      this.apply(post, out);
      return { post: await this.save(post, event, `Provider post ${out.id}: ${out.status}.`) };
    } catch (e) {
      if (e instanceof DevError && e.retryable) {
        post.status = 'unknown';
        post.lastError = e.message;
        return { post: await this.save(post, 'outcome unknown', e.message) };
      }
      post.status = 'draft';
      post.lastError = e instanceof Error ? e.message : String(e);
      await this.save(post, 'refused', post.lastError);
      throw e;
    }
  }

  private apply(post: KitPost, out: ProviderPost) {
    post.providerPostId = out.id;
    post.status = out.status === 'draft' ? 'scheduled' : out.status === 'unknown' ? 'unknown' : out.status;
    post.platforms = out.platforms;
    post.lastError = out.platforms.find((p) => p.error)?.error ?? null;
  }

  /** The provider's word on where the post is now. */
  async refresh(caller: Caller, id: string) {
    const post = await this.get(caller, id);
    if (post.providerPostId) {
      this.apply(post, await this.deps.provider.getPost(post.providerPostId));
      return { post: await this.save(post, 'refreshed', post.status) };
    }
    if (post.status === 'unknown') {
      // Inside the provider's idempotency window, the same request id is the
      // same post: asking again cannot create a second one.
      if (post.submittedAt && Date.now() - Date.parse(post.submittedAt) < RECONCILE_WINDOW_MS) return this.send(post, 'reconciled');
      throw new DevError(
        ERR.STATE,
        'Too long has passed to ask the provider safely. Check whether it went out at the provider; if it did not, abandon this attempt and submit again.',
        { httpStatus: 409 }
      );
    }
    return { post };
  }

  /** A person's decision that an unknown attempt did not go out. */
  async abandon(caller: Caller, id: string) {
    const post = await this.get(caller, id);
    if (post.status !== 'unknown') throw new DevError(ERR.STATE, 'Only an attempt whose outcome is unknown can be abandoned.', { httpStatus: 409 });
    post.status = 'draft';
    post.requestId = randomUUID();
    post.submittedAt = null;
    return { post: await this.save(post, 'abandoned', 'Marked as not sent by the owner; a new request id will be used.') };
  }

  async cancel(caller: Caller, id: string) {
    const post = await this.get(caller, id);
    if (post.status !== 'draft') throw new DevError(ERR.STATE, 'Only a draft can be cancelled here.', { httpStatus: 409 });
    post.status = 'cancelled';
    return { post: await this.save(post, 'cancelled') };
  }
}
