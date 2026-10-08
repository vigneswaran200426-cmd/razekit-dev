// GitHub delivery as the RazeKit DEV app, against an in-memory GitHub.
//
// The fake implements just the REST calls delivery makes, checks every
// credential the way GitHub would (the App JWT's signature against the App's
// public key, installation tokens by value and expiry), and records writes, so
// the tests can prove what reached "GitHub" — and what never did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify } from 'node:crypto';
import { APP_ID, PEM, publicKey, fakeGitHub } from './helpers/github.js';
import { appJwt, GitHubApp } from '../src/development/delivery/github.js';
import { DevError } from '../src/development/engine/errors.js';

const request = (over: any = {}) => ({
  owner: 'acme',
  repo: 'site',
  branch: 'razekit-dev/dtk_1',
  files: [
    { path: 'razekit-dev/dtk_1/index.html', content: '<!doctype html><title>x</title>' },
    { path: 'razekit-dev/dtk_1/tests/a.test.mjs', content: 'import "node:test";' },
  ],
  commitMessage: 'RazeKit DEV: x',
  title: 'RazeKit DEV: x',
  body: 'b',
  ...over,
});

test('the App JWT is RS256, signed by the App key, issued by the App id, and short-lived', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const [h, p, s] = appJwt(APP_ID, PEM, now).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.iss, APP_ID);
  assert.ok(claims.iat * 1000 < now, 'backdated for clock drift');
  assert.ok(claims.exp * 1000 - now <= 10 * 60_000, 'GitHub refuses more than ten minutes');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('delivery makes one branch, one commit and one draft PR, with a repo-scoped least-privilege token', async () => {
  const gh = fakeGitHub();
  const app = new GitHubApp({ appId: APP_ID, privateKey: PEM }, { fetch: gh.fetch, now: gh.now });
  const out = await app.deliver(request());

  assert.equal(out.repository, 'acme/site');
  assert.equal(out.baseBranch, 'main');
  assert.equal(out.pullRequest.draft, true);
  assert.equal(out.replayed, false);
  assert.equal(gh.refs.get('acme/site:razekit-dev/dtk_1'), out.commitSha);
  assert.equal(gh.refs.get('acme/site:main'), 'base0', 'the base branch is never written');
  assert.equal(gh.prs.length, 1);
  assert.deepEqual(gh.prs[0], { number: 1, html_url: 'https://github.com/acme/site/pull/1', draft: true, head: 'razekit-dev/dtk_1', base: 'main' });
  assert.deepEqual(gh.trees[0].tree.map((e: any) => e.path), ['razekit-dev/dtk_1/index.html', 'razekit-dev/dtk_1/tests/a.test.mjs']);
  const [token] = [...gh.tokens.values()];
  assert.deepEqual(token.perms, { contents: 'write', pull_requests: 'write' });
  assert.equal(token.repo, 'site', 'the token covers only the delivery repository');
});

test('a repeated delivery returns the first one and writes nothing new', async () => {
  const gh = fakeGitHub();
  const app = new GitHubApp({ appId: APP_ID, privateKey: PEM }, { fetch: gh.fetch, now: gh.now });
  const first = await app.deliver(request());
  const again = await app.deliver(request());
  assert.equal(again.replayed, true);
  assert.equal(again.commitSha, first.commitSha);
  assert.equal(again.pullRequest.url, first.pullRequest.url);
  assert.equal(gh.trees.length, 1, 'no second commit');
  assert.equal(gh.prs.length, 1, 'no second pull request');
});

test('a branch created by an attempt whose reply was lost is found, not made twice', async () => {
  const gh = fakeGitHub({ dropRefReply: true });
  const app = new GitHubApp({ appId: APP_ID, privateKey: PEM }, { fetch: gh.fetch, now: gh.now });
  await assert.rejects(app.deliver(request()), (e: unknown) => e instanceof DevError && e.retryable, 'an unknown outcome is retryable');
  const retried = await app.deliver(request());
  assert.equal(retried.replayed, true);
  assert.equal(retried.commitSha, gh.refs.get('acme/site:razekit-dev/dtk_1'));
  assert.equal(gh.prs.length, 1);
});

test('tokens are reused until near expiry, then replaced', async () => {
  const gh = fakeGitHub({ tokenTtlMs: 60 * 60_000 });
  const app = new GitHubApp({ appId: APP_ID, privateKey: PEM }, { fetch: gh.fetch, now: gh.now });
  await app.deliver(request());
  assert.equal(gh.tokens.size, 1);
  gh.advance(10 * 60_000);
  await app.deliver(request({ branch: 'razekit-dev/dtk_2' }));
  assert.equal(gh.tokens.size, 1, 'still valid: reused');
  gh.advance(47 * 60_000);
  await app.deliver(request({ branch: 'razekit-dev/dtk_3' }));
  assert.equal(gh.tokens.size, 2, 'inside the five-minute margin: replaced before use');
});

test('a token GitHub rejects is replaced once and the call retried', async () => {
  const gh = fakeGitHub();
  const app = new GitHubApp({ appId: APP_ID, privateKey: PEM }, { fetch: gh.fetch, now: gh.now });
  await app.deliver(request());
  gh.tokens.clear(); // revoked server-side
  const out = await app.deliver(request({ branch: 'razekit-dev/dtk_9' }));
  assert.equal(out.replayed, false);
  assert.equal(gh.prs.length, 2);
});

test('delivery refuses the base branch, foreign branch names, unsafe paths and uninstalled repositories', async () => {
  const gh = fakeGitHub();
  const app = new GitHubApp({ appId: APP_ID, privateKey: PEM }, { fetch: gh.fetch, now: gh.now });
  await assert.rejects(app.deliver(request({ branch: 'main' })), /razekit-dev\//);
  await assert.rejects(app.deliver(request({ branch: 'razekit-dev/x', baseBranch: 'razekit-dev/x' })), /base branch/);
  await assert.rejects(app.deliver(request({ branch: 'razekit-dev/../main' })), /razekit-dev\//);
  await assert.rejects(app.deliver(request({ files: [{ path: '../../.github/workflows/x.yml', content: 'x' }] })));
  await assert.rejects(app.deliver(request({ repo: 'other' })), (e: unknown) => e instanceof DevError && /not installed/.test(e.message) && !e.retryable);
  assert.equal(gh.refs.size, 1, 'nothing was written');
  assert.equal(gh.prs.length, 0);
});

test('an unconfigured app refuses to exist rather than failing later', () => {
  assert.throws(() => new GitHubApp({ appId: '', privateKey: PEM }), /not configured/);
  assert.throws(() => new GitHubApp({ appId: APP_ID, privateKey: 'not a key' }), /not configured/);
});
