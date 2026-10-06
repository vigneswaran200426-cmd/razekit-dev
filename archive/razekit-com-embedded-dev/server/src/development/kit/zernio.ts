// Zernio, the publishing provider behind Kit. Written against Zernio's REST
// API as its official SDK (@zernio/node 0.2.893) defines it:
//   base https://zernio.com/api, `Authorization: Bearer <key>`
//   GET  /v1/accounts            → { accounts: SocialAccount[] }
//   POST /v1/posts               → { post }   (x-request-id: idempotent ~5 min)
//   GET  /v1/posts/{postId}      → { post }
// Only the fields Kit needs are read. Nothing here invents a status: a post
// is published when Zernio says it is.
import { DevError, ERR } from '../engine/errors.js';

export interface SocialAccount {
  id: string;
  platform: string;
  profileId: string | null;
  username: string | null;
  displayName: string | null;
  active: boolean;
  needsReconnection: boolean;
}

export type ProviderPostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';

export interface ProviderPost {
  id: string;
  status: ProviderPostStatus | 'unknown';
  scheduledFor: string | null;
  platforms: { platform: string; accountId: string; status: string; url: string | null; error: string | null; publishedAt: string | null }[];
}

export interface PublishRequest {
  content: string;
  mediaUrls: string[];
  targets: { platform: string; accountId: string; content: string | null }[];
  publishNow: boolean;
  scheduledFor: string | null;
  /** Stable per Kit post: a retry is recognised by Zernio as the same post. */
  requestId: string;
}

export interface SocialProvider {
  readonly name: string;
  readonly configured: boolean;
  listAccounts(): Promise<SocialAccount[]>;
  publish(req: PublishRequest): Promise<ProviderPost>;
  getPost(id: string): Promise<ProviderPost>;
}

type Fetch = typeof fetch;

const STATUSES = new Set(['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled']);

function toPost(p: any): ProviderPost {
  if (!p || typeof p._id !== 'string') throw new DevError(ERR.PROVIDER_OUTPUT, 'Zernio did not return a post.', { httpStatus: 502 });
  return {
    id: p._id,
    status: STATUSES.has(p.status) ? p.status : 'unknown',
    scheduledFor: typeof p.scheduledFor === 'string' ? p.scheduledFor : null,
    platforms: (Array.isArray(p.platforms) ? p.platforms : []).map((t: any) => ({
      platform: String(t?.platform ?? ''),
      accountId: typeof t?.accountId === 'string' ? t.accountId : String(t?.accountId?._id ?? ''),
      status: String(t?.status ?? 'pending'),
      url: typeof t?.platformPostUrl === 'string' ? t.platformPostUrl : null,
      error: typeof t?.errorMessage === 'string' ? t.errorMessage.slice(0, 500) : null,
      publishedAt: typeof t?.publishedAt === 'string' ? t.publishedAt : null,
    })),
  };
}

export function createZernio(cfg: { apiKey: string; baseUrl?: string; timeoutMs?: number }, deps: { fetch?: Fetch } = {}): SocialProvider {
  const base = (cfg.baseUrl || 'https://zernio.com/api').replace(/\/$/, '');
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    if (!cfg.apiKey) throw new DevError(ERR.NOT_CONFIGURED, 'Kit publishing is not set up on this deployment.', { httpStatus: 503 });
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
      });
    } catch {
      // The request may or may not have reached Zernio: the caller decides
      // how to reconcile. Never a blind retry.
      throw new DevError(ERR.PROVIDER_FAILED, 'Zernio could not be reached; whether it received the request is unknown.', { httpStatus: 502, retryable: true });
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* none */
    }
    if (res.status === 401 || res.status === 403) throw new DevError(ERR.PROVIDER_UNAVAILABLE, 'Zernio rejected the configured credential.', { httpStatus: 502 });
    if (res.status === 429 || res.status >= 500) throw new DevError(ERR.PROVIDER_FAILED, `Zernio is not available right now (HTTP ${res.status}).`, { httpStatus: 502, retryable: true });
    if (res.status >= 400) {
      const reason = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `HTTP ${res.status}`;
      throw new DevError(ERR.VALIDATION, `Zernio refused it: ${String(reason).slice(0, 300)}`, { httpStatus: 400 });
    }
    return data;
  }

  return {
    name: 'zernio',
    configured: Boolean(cfg.apiKey),
    async listAccounts() {
      const data = await call('GET', '/v1/accounts');
      return (Array.isArray(data?.accounts) ? data.accounts : []).map((a: any) => ({
        id: String(a._id),
        platform: String(a.platform),
        profileId: typeof a.profileId === 'string' ? a.profileId : a.profileId?._id ? String(a.profileId._id) : null,
        username: a.username ?? null,
        displayName: a.displayName ?? null,
        active: a.isActive !== false,
        needsReconnection: Boolean(a.needsReconnection),
      }));
    },
    async publish(req) {
      const body: any = {
        content: req.content,
        platforms: req.targets.map((t) => ({ platform: t.platform, accountId: t.accountId, ...(t.content ? { platformSpecificContent: t.content } : {}) })),
        ...(req.mediaUrls.length ? { mediaUrls: req.mediaUrls } : {}),
        ...(req.publishNow ? { publishNow: true } : { scheduledFor: req.scheduledFor }),
      };
      const data = await call('POST', '/v1/posts', body, { 'x-request-id': req.requestId });
      return toPost(data?.post);
    },
    async getPost(id) {
      const data = await call('GET', `/v1/posts/${encodeURIComponent(id)}`);
      return toPost(data?.post);
    },
  };
}
