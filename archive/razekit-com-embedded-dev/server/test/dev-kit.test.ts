// Kit against Zernio's real REST contract (as its official SDK defines it),
// served by an in-memory fake: accounts, posts, the x-request-id idempotency
// window, and post status. Nothing is published until "Zernio" says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZernio } from '../src/development/kit/zernio.js';
import { Kit } from '../src/development/kit/kit.js';
import { MemoryDevStore } from '../src/development/store/memory.js';
import { DevError } from '../src/development/engine/errors.js';

const KEY = 'sk_test_zernio_key_0000000000';

function fakeZernio(opts: { dropFirstCreate?: boolean } = {}) {
  const accounts = [
    { _id: 'acc_x1', platform: 'twitter', profileId: 'prof_rk', username: 'razekit', isActive: true },
    { _id: 'acc_li', platform: 'linkedin', profileId: 'prof_rk', username: 'razekit', isActive: true },
    { _id: 'acc_other', platform: 'twitter', profileId: 'prof_someone_else', username: 'other', isActive: true },
  ];
  const posts = new Map<string, any>();
  const byRequest = new Map<string, string>();
  const creates: any[] = [];
  let dropped = false;
  const fetch = async (url: string, init: any) => {
    const u = new URL(url);
    if (init.headers.authorization !== `Bearer ${KEY}`) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    const json = (status: number, body: any) => new Response(JSON.stringify(body), { status });
    if (u.pathname === '/api/v1/accounts') return json(200, { accounts, hasAnalyticsAccess: false });
    if (u.pathname === '/api/v1/posts' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      creates.push({ body, requestId: init.headers['x-request-id'] });
      const seen = byRequest.get(init.headers['x-request-id']);
      if (seen) return json(200, { post: posts.get(seen) });
      const id = `post_${posts.size + 1}`;
      const post = { _id: id, status: body.publishNow ? 'publishing' : 'scheduled', scheduledFor: body.scheduledFor, platforms: body.platforms.map((p: any) => ({ platform: p.platform, accountId: p.accountId, status: 'pending' })) };
      posts.set(id, post);
      byRequest.set(init.headers['x-request-id'], id);
      if (opts.dropFirstCreate && !dropped) {
        dropped = true;
        throw new TypeError('socket hang up');
      }
      return json(201, { post });
    }
    const m = u.pathname.match(/^\/api\/v1\/posts\/(.+)$/);
    if (m && init.method === 'GET') return posts.has(m[1]) ? json(200, { post: posts.get(m[1]) }) : json(404, { error: 'Not found' });
    return json(404, {});
  };
  return { fetch: fetch as any, posts, creates, publish: (id: string) => {
    const p = posts.get(id);
    p.status = 'published';
    p.platforms = p.platforms.map((t: any) => ({ ...t, status: 'published', platformPostUrl: `https://x.com/razekit/status/${id}`, publishedAt: '2026-09-25T10:00:00.000Z' }));
  } };
}

async function setup(opts: any = {}) {
  const z = fakeZernio(opts);
  const store = new MemoryDevStore();
  const kit = new Kit({ store, provider: createZernio({ apiKey: KEY, baseUrl: 'https://zernio.test/api' }, { fetch: z.fetch }) });
  return { z, store, kit };
}

const admin = { id: 'root', role: 'admin' };
const alice = { id: 'alice', role: 'user' };

test('a user sees and posts only to the accounts of the provider profile an admin linked to them', async () => {
  const { kit } = await setup();
  assert.deepEqual(await kit.accounts(alice), { configured: true, linked: false, accounts: [] });
  await assert.rejects(kit.linkProfile(admin, '', 'x'), /user id and a provider profile id/);
  await kit.linkProfile(admin, 'alice', 'prof_rk');
  const mine = (await kit.accounts(alice)).accounts.map((a: any) => a.id);
  assert.deepEqual(mine, ['acc_x1', 'acc_li']);
  assert.equal((await kit.accounts(admin)).accounts.length, 3, 'administrators see every account');

  const { post } = await kit.create(alice, { content: 'Hello', targets: [{ platform: 'twitter', accountId: 'acc_other' }] });
  await assert.rejects(kit.submit(alice, post.id), (e: unknown) => e instanceof DevError && (e as DevError).httpStatus === 403, 'authority is checked at submit');
});

test('master content becomes per-platform variants, reviewed against each platform before anything is sent', async () => {
  const { kit, z } = await setup();
  await kit.linkProfile(admin, 'alice', 'prof_rk');
  const long = 'x'.repeat(300);
  const { post, problems } = await kit.create(alice, { content: long, targets: [{ platform: 'twitter', accountId: 'acc_x1' }, { platform: 'linkedin', accountId: 'acc_li' }] });
  assert.deepEqual(problems, ['twitter: 300 characters, over its 280 limit.']);
  await assert.rejects(kit.submit(alice, post.id), /over its 280 limit/);
  assert.equal(z.creates.length, 0, 'nothing reached the provider');

  const fixed = await kit.update(alice, post.id, { targets: [{ platform: 'twitter', accountId: 'acc_x1', content: 'Short for X' }, { platform: 'linkedin', accountId: 'acc_li' }] });
  assert.deepEqual(fixed.problems, []);
  const sent = (await kit.submit(alice, post.id)).post;
  assert.equal(sent.status, 'publishing', 'submitted is not published');
  assert.deepEqual(z.creates[0].body.platforms, [{ platform: 'twitter', accountId: 'acc_x1', platformSpecificContent: 'Short for X' }, { platform: 'linkedin', accountId: 'acc_li' }]);
  assert.equal(z.creates[0].requestId, post.requestId);

  z.publish(sent.providerPostId);
  const live = (await kit.refresh(alice, post.id)).post;
  assert.equal(live.status, 'published', 'published because the provider says so');
  assert.equal(live.platforms[0].url, `https://x.com/razekit/status/${sent.providerPostId}`);
  assert.ok(!JSON.stringify(live).match(/likes|views|followers|impressions/i), 'no metric is shown that the provider did not give');
});

test('a lost answer leaves the post unknown, and reconciling inside the window finds the same post', async () => {
  const { kit, z } = await setup({ dropFirstCreate: true });
  const { post } = await kit.create(admin, { content: 'Launch', targets: [{ platform: 'twitter', accountId: 'acc_x1' }] });
  const unknown = (await kit.submit(admin, post.id)).post;
  assert.equal(unknown.status, 'unknown');
  const reconciled = (await kit.refresh(admin, post.id)).post;
  assert.equal(reconciled.status, 'publishing');
  assert.equal(z.posts.size, 1, 'one post at the provider, not two');
  assert.equal(new Set(z.creates.map((c) => c.requestId)).size, 1, 'the retry carried the same request id');
});

test('scheduling, drafts and a refused credential', async () => {
  const { kit } = await setup();
  await assert.rejects(kit.create(admin, { content: 'x', targets: [], publishNow: false, scheduledFor: 'tomorrow' }), /valid time/);
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const { post } = await kit.create(admin, { content: 'Later', targets: [{ platform: 'twitter', accountId: 'acc_x1' }], publishNow: false, scheduledFor: soon });
  assert.equal((await kit.submit(admin, post.id)).post.status, 'scheduled');
  await assert.rejects(kit.update(admin, post.id, { content: 'y' }), /Only a draft/);

  const bad = new Kit({ store: new MemoryDevStore(), provider: createZernio({ apiKey: 'wrong-key-000000000' }, { fetch: fakeZernio().fetch }) });
  await assert.rejects(bad.accounts(admin), /rejected the configured credential/);
  const off = new Kit({ store: new MemoryDevStore(), provider: createZernio({ apiKey: '' }) });
  assert.deepEqual(await off.accounts(admin), { configured: false, linked: false, accounts: [] });
});
