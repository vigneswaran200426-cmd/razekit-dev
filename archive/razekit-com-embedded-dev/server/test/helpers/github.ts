// An in-memory GitHub for delivery tests: just the REST calls delivery makes,
// with credentials checked the way GitHub checks them. Uses a throwaway key
// generated per run, never a real one.
import { generateKeyPairSync, createVerify } from 'node:crypto';

export const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
export const APP_ID = '5060697';

export function fakeGitHub(opts: { installedOn?: string[]; tokenTtlMs?: number; dropRefReply?: boolean } = {}) {
  let clock = Date.parse('2026-09-24T12:00:00Z');
  const installedOn = opts.installedOn ?? ['acme/site'];
  const tokens = new Map<string, { repo: string; exp: number; perms: any }>();
  const refs = new Map<string, string>([['acme/site:main', 'base0']]);
  const commits = new Map<string, any>([['base0', { sha: 'base0', tree: { sha: 'tree0' } }]]);
  const trees: any[] = [];
  const prs: any[] = [];
  const log: string[] = [];
  let n = 0;
  let droppedOnce = false;

  const verifyJwt = (auth: string) => {
    const jwt = auth.replace(/^Bearer /, '');
    const [h, p, sig] = jwt.split('.');
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    return ok && claims.iss === APP_ID && claims.exp * 1000 > clock && claims.exp - claims.iat <= 600;
  };

  const fetch = async (url: string | URL | Request, init: any = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    const auth = init.headers?.authorization || '';
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push(`${method} ${u.pathname}${u.search}`);
    const reply = (status: number, data: any) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    let m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/);
    if (m) {
      if (!verifyJwt(auth)) return reply(401, { message: 'bad jwt' });
      return installedOn.includes(`${m[1]}/${m[2]}`) ? reply(200, { id: 77 }) : reply(404, { message: 'Not Found' });
    }
    m = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (m) {
      if (!verifyJwt(auth)) return reply(401, { message: 'bad jwt' });
      const token = `ghs_${++n}`;
      const exp = clock + (opts.tokenTtlMs ?? 3_600_000);
      tokens.set(token, { repo: body.repositories[0], exp, perms: body.permissions });
      return reply(201, { token, expires_at: new Date(exp).toISOString() });
    }
    m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return reply(404, {});
    const [, owner, repo, rest = ''] = m;
    const t = tokens.get(auth.replace(/^token /, ''));
    if (!t || t.exp <= clock || t.repo !== repo) return reply(401, { message: 'Bad credentials' });
    const full = `${owner}/${repo}`;
    if (rest === '') return reply(200, { default_branch: 'main' });
    let r = rest.match(/^\/git\/ref\/heads\/(.+)$/);
    if (r && method === 'GET') {
      const sha = refs.get(`${full}:${decodeURIComponent(r[1])}`);
      return sha ? reply(200, { object: { sha } }) : reply(404, {});
    }
    if (rest.startsWith('/git/commits/') && method === 'GET') return reply(200, commits.get(rest.split('/').pop()!));
    if (rest === '/git/trees') {
      trees.push(body);
      return reply(201, { sha: `tree${trees.length}` });
    }
    if (rest === '/git/commits') {
      const sha = `c${++n}`;
      commits.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents });
      return reply(201, { sha });
    }
    if (rest === '/git/refs') {
      const key = `${full}:${body.ref.replace('refs/heads/', '')}`;
      if (refs.has(key)) return reply(422, { message: 'Reference already exists' });
      refs.set(key, body.sha);
      if (opts.dropRefReply && !droppedOnce) {
        droppedOnce = true;
        throw new TypeError('socket hang up');
      }
      return reply(201, { ref: body.ref });
    }
    if (rest.startsWith('/pulls') && method === 'GET') {
      const head = u.searchParams.get('head')!;
      return reply(200, prs.filter((p) => `${owner}:${p.head}` === head));
    }
    if (rest === '/pulls' && method === 'POST') {
      const pr = { number: prs.length + 1, html_url: `https://github.com/${full}/pull/${prs.length + 1}`, draft: body.draft, head: body.head, base: body.base };
      prs.push(pr);
      return reply(201, pr);
    }
    return reply(404, {});
  };
  return { fetch: fetch as any, refs, trees, prs, log, tokens, now: () => clock, advance: (ms: number) => (clock += ms) };
}

