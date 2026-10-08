// Delivery of a verified build to a GitHub repository, as the RazeKit DEV
// GitHub App — never with a personal token.
//
// Authority is narrow on purpose:
//   • the App proves itself with a short-lived JWT signed by its private key,
//     and trades it for an installation token scoped to the ONE repository
//     being delivered to, with only contents + pull_requests write;
//   • delivery only ever creates a new branch under razekit-dev/ and opens a
//     draft pull request against the base branch. It never writes to the base
//     branch, never force-pushes, never merges;
//   • tokens are cached until five minutes before they expire, and a token
//     GitHub rejects (expired or revoked) is replaced once and the call retried.
//
// Delivery is idempotent on the branch name. A retry after an answer was lost
// finds the branch (and the pull request) it already made and returns them;
// it never makes a second commit or a second pull request.
import { createSign } from 'node:crypto';
import { DevError, ERR } from '../engine/errors.js';
import { safeRelativePath } from '../engine/paths.js';

export interface GitHubAppConfig {
  appId: string;
  /** PEM. Kept in memory only; never logged, never sent anywhere but the signer. */
  privateKey: string;
  apiBase?: string;
}

export interface DeliveryFile {
  path: string;
  content: string;
}

export interface DeliveryRequest {
  owner: string;
  repo: string;
  /** Must start with razekit-dev/. */
  branch: string;
  /** The branch the pull request targets. Default: the repository's default branch. */
  baseBranch?: string | null;
  files: DeliveryFile[];
  commitMessage: string;
  title: string;
  body: string;
}

export interface DeliveryResult {
  repository: string;
  branch: string;
  baseBranch: string;
  commitSha: string;
  pullRequest: { number: number; url: string; draft: boolean };
  /** True when this call found the delivery an earlier call already made. */
  replayed: boolean;
}

type Fetch = typeof fetch;
type Reply = { status: number; data: any };

const BRANCH_PREFIX = 'razekit-dev/';
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_FILES = 500;

/** The App's own credential: an RS256 JWT, valid for eight minutes. */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // Issued a minute in the past, to tolerate clock drift; GitHub refuses an
  // expiry more than ten minutes out.
  const iat = Math.floor(nowMs / 1000) - 60;
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat, exp: iat + 9 * 60, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** A GitHub answer that is not what we needed, as a DevError. Never the response body. */
function refused(reply: Reply, what: string): DevError {
  const s = reply.status;
  if (s === 404) return new DevError(ERR.DELIVERY, `GitHub could not ${what}: not found, or the RazeKit DEV app is not installed there.`, { httpStatus: 502, retryable: false });
  if (s === 401 || s === 403) return new DevError(ERR.DELIVERY, `GitHub refused to ${what} (HTTP ${s}).`, { httpStatus: 502, retryable: s === 403 && /rate limit/i.test(String(reply.data?.message ?? '')) });
  if (s === 429 || s >= 500) return new DevError(ERR.DELIVERY, `GitHub is not available to ${what} right now (HTTP ${s}).`, { httpStatus: 502, retryable: true });
  return new DevError(ERR.DELIVERY, `GitHub refused to ${what} (HTTP ${s}).`, { httpStatus: 502, retryable: false });
}

export class GitHubApp {
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private installations = new Map<string, number>();

  constructor(private cfg: GitHubAppConfig, private deps: { fetch?: Fetch; now?: () => number } = {}) {
    if (!cfg.appId || !cfg.privateKey.includes('PRIVATE KEY')) {
      throw new DevError(ERR.NOT_CONFIGURED, 'The GitHub App is not configured.', { httpStatus: 503 });
    }
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async call(method: string, path: string, authorization: string, body?: unknown): Promise<Reply> {
    const base = (this.cfg.apiBase || 'https://api.github.com').replace(/\/$/, '');
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'razekit-dev',
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new DevError(ERR.DELIVERY, 'GitHub could not be reached.', { httpStatus: 502, retryable: true });
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, data };
  }

  /** The installation that covers owner/repo. 404 means the App is not installed there. */
  async installationFor(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase();
    const known = this.installations.get(key);
    if (known) return known;
    const reply = await this.call('GET', `/repos/${owner}/${repo}/installation`, `Bearer ${appJwt(this.cfg.appId, this.cfg.privateKey, this.now())}`);
    if (reply.status !== 200 || !reply.data?.id) throw refused(reply, `find the app installation for ${owner}/${repo}`);
    this.installations.set(key, reply.data.id);
    return reply.data.id;
  }

  /** An installation token for exactly this repository, contents + pull requests only. */
  private async repoToken(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - this.now() > TOKEN_MARGIN_MS) return cached.token;
    const installation = await this.installationFor(owner, repo);
    const reply = await this.call(
      'POST',
      `/app/installations/${installation}/access_tokens`,
      `Bearer ${appJwt(this.cfg.appId, this.cfg.privateKey, this.now())}`,
      { repositories: [repo], permissions: { contents: 'write', pull_requests: 'write' } }
    );
    if (reply.status !== 201 || typeof reply.data?.token !== 'string') throw refused(reply, `issue a token for ${owner}/${repo}`);
    const expiresAt = Date.parse(reply.data.expires_at) || this.now() + 60 * 60_000;
    this.tokens.set(key, { token: reply.data.token, expiresAt });
    return reply.data.token;
  }

  private async repoCall(owner: string, repo: string, method: string, path: string, body?: unknown): Promise<Reply> {
    const run = async () => this.call(method, `/repos/${owner}/${repo}${path}`, `token ${await this.repoToken(owner, repo)}`, body);
    const first = await run();
    if (first.status !== 401) return first;
    // Expired or revoked: one fresh token, one retry.
    this.tokens.delete(`${owner}/${repo}`.toLowerCase());
    return run();
  }

  async deliver(req: DeliveryRequest): Promise<DeliveryResult> {
    const { owner, repo } = req;
    if (!NAME.test(owner) || !NAME.test(repo)) throw new DevError(ERR.VALIDATION, 'That is not a repository name.', { httpStatus: 400 });
    if (!req.branch.startsWith(BRANCH_PREFIX) || !/^[A-Za-z0-9/_.-]+$/.test(req.branch) || req.branch.includes('..')) {
      throw new DevError(ERR.VALIDATION, `Delivery branches must be under ${BRANCH_PREFIX}.`, { httpStatus: 400 });
    }
    if (req.files.length === 0 || req.files.length > MAX_FILES) throw new DevError(ERR.VALIDATION, `A delivery carries between 1 and ${MAX_FILES} files.`, { httpStatus: 400 });
    const files = req.files.map((f) => ({ path: safeRelativePath(f.path), content: f.content }));

    const info = await this.repoCall(owner, repo, 'GET', '');
    if (info.status !== 200) throw refused(info, `read ${owner}/${repo}`);
    const base: string = req.baseBranch || info.data.default_branch;
    if (req.branch === base) throw new DevError(ERR.VALIDATION, 'Delivery never writes to the base branch.', { httpStatus: 400 });
    const ref = `/git/ref/heads/${req.branch.split('/').map(encodeURIComponent).join('/')}`;

    let commitSha: string;
    let replayed = false;
    const existing = await this.repoCall(owner, repo, 'GET', ref);
    if (existing.status === 200) {
      commitSha = existing.data.object.sha;
      replayed = true;
    } else if (existing.status === 404) {
      const baseRef = await this.repoCall(owner, repo, 'GET', `/git/ref/heads/${encodeURIComponent(base)}`);
      if (baseRef.status !== 200) throw refused(baseRef, `read the ${base} branch`);
      const parent: string = baseRef.data.object.sha;
      const parentCommit = await this.repoCall(owner, repo, 'GET', `/git/commits/${parent}`);
      if (parentCommit.status !== 200) throw refused(parentCommit, 'read the base commit');
      const tree = await this.repoCall(owner, repo, 'POST', '/git/trees', {
        base_tree: parentCommit.data.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      });
      if (tree.status !== 201) throw refused(tree, 'write the files');
      const commit = await this.repoCall(owner, repo, 'POST', '/git/commits', { message: req.commitMessage, tree: tree.data.sha, parents: [parent] });
      if (commit.status !== 201) throw refused(commit, 'commit the files');
      const created = await this.repoCall(owner, repo, 'POST', '/git/refs', { ref: `refs/heads/${req.branch}`, sha: commit.data.sha });
      if (created.status === 201) {
        commitSha = commit.data.sha;
      } else if (created.status === 422) {
        // The branch appeared meanwhile: an earlier attempt whose answer was
        // lost. Its commit is the delivery; ours is left unreferenced.
        const again = await this.repoCall(owner, repo, 'GET', ref);
        if (again.status !== 200) throw refused(again, 'read the delivery branch');
        commitSha = again.data.object.sha;
        replayed = true;
      } else {
        throw refused(created, 'create the delivery branch');
      }
    } else {
      throw refused(existing, 'read the delivery branch');
    }

    const findPr = async () => {
      const list = await this.repoCall(owner, repo, 'GET', `/pulls?state=all&head=${encodeURIComponent(`${owner}:${req.branch}`)}`);
      if (list.status !== 200) throw refused(list, 'list pull requests');
      return Array.isArray(list.data) ? list.data[0] ?? null : null;
    };
    let pr = await findPr();
    if (pr) replayed = true;
    else {
      const opened = await this.repoCall(owner, repo, 'POST', '/pulls', { title: req.title, head: req.branch, base, body: req.body, draft: true });
      if (opened.status === 201) pr = opened.data;
      else if (opened.status === 422 && (pr = await findPr())) replayed = true;
      else throw refused(opened, 'open the pull request');
    }

    return {
      repository: `${owner}/${repo}`,
      branch: req.branch,
      baseBranch: base,
      commitSha,
      pullRequest: { number: pr.number, url: pr.html_url, draft: Boolean(pr.draft) },
      replayed,
    };
  }
}
