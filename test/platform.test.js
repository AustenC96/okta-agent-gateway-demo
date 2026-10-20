import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createBootstrap, toTenant, validGatewayUrl } from '../bootstrap.js';
import { createHooks, normalize, callbackAllowed } from '../hooks.js';
import { startApp, browser } from './helpers.js';

const jwt = (expSec) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`;

// A fake platform: token endpoint + bootstrap endpoint, counting calls.
function fakePlatform({ demos = {}, tokenFor = () => jwt(Math.floor(Date.now() / 1000) + 3600) } = {}) {
  const calls = { token: 0, bootstrap: [], auth: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/oauth/token') {
      calls.token++;
      const b = JSON.parse(init.body);
      assert.equal(b.grant_type, 'client_credentials'); assert.equal(b.scope, 'bootstrap');
      return new Response(JSON.stringify({ access_token: tokenFor(calls.token), expires_in: 3600 }), { status: 200 });
    }
    if (u.pathname.startsWith('/bootstrap/')) {
      calls.bootstrap.push(u.pathname); calls.auth.push(init.headers.Authorization);
      const name = decodeURIComponent(u.pathname.split('/').pop());
      return demos[name] ? new Response(JSON.stringify(demos[name]), { status: 200 }) : new Response('{}', { status: 404 });
    }
    if (init.method === 'PATCH') { calls.patched ??= []; calls.patched.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}
const mk = (p, extra = {}) => createBootstrap({ appId: 'APP1', clientId: 'id', clientSecret: 'sec', endpoint: 'https://api.test', tokenEndpoint: 'https://auth.test/oauth/token', fetchImpl: p.fetchImpl, ...extra });
const DEMO = { settings: { gatewayUrl: 'https://acme.gateway.oktapreview.com/mcp/servers/x' }, oidc_configuration: { issuer: 'acme.okta.com', client_id: 'cid', client_secret: 'csec' } };

test('bootstrap: fetches with a bearer token, caches the token and the demo', async () => {
  const p = fakePlatform({ demos: { 'my-demo': DEMO } }); const b = mk(p);
  assert.deepEqual(await b.get('my-demo'), DEMO);
  await b.get('my-demo');
  assert.equal(p.calls.token, 1, 'one token for both lookups'); assert.equal(p.calls.bootstrap.length, 1, 'second lookup came from cache');
  assert.match(p.calls.auth[0], /^Bearer h\./); assert.equal(p.calls.bootstrap[0], '/bootstrap/APP1/my-demo');
});

test('bootstrap: cache expires, evict forces a refetch, unknown demos are null and not cached', async () => {
  let t = 1_000_000; const p = fakePlatform({ demos: { a: DEMO } }); const b = mk(p, { now: () => t, cacheMinutes: 1 });
  await b.get('a'); t += 30_000; await b.get('a'); assert.equal(p.calls.bootstrap.length, 1);
  t += 40_000; await b.get('a'); assert.equal(p.calls.bootstrap.length, 2, 'expired after a minute');
  b.evict('a'); await b.get('a'); assert.equal(p.calls.bootstrap.length, 3);
  assert.equal(await b.get('ghost'), null); assert.equal(b.cacheSize(), 1);
});

test('bootstrap: path-unsafe names are encoded, concurrent callers share one token request, a 401 refreshes once', async () => {
  const p = fakePlatform({ demos: { a: DEMO } }); const b = mk(p);
  await Promise.all([b.get('a'), b.get('a'), b.get('zzz')]);
  assert.equal(p.calls.token, 1);
  await b.get('../x'); assert.ok(p.calls.bootstrap.some((x) => x.endsWith('/..%2Fx')), 'slash is encoded');
  let n = 0; const flaky = { fetchImpl: async (u, i) => { if (new URL(u).pathname.startsWith('/bootstrap/') && n++ === 0) return new Response('{}', { status: 401 }); return p.fetchImpl(u, i); } };
  assert.deepEqual(await mk(flaky).get('a'), DEMO);
});

test('bootstrap: requires credentials and surfaces platform errors', async () => {
  assert.throws(() => createBootstrap({ appId: 'x' }), /DEMO_API/);
  const down = { fetchImpl: async () => new Response('x', { status: 500 }) };
  await assert.rejects(mk(down).get('a'), /token request failed \(500\)/);
});

test('toTenant maps a bootstrap record and rejects incomplete ones', () => {
  assert.deepEqual(toTenant(DEMO), { orgUrl: 'https://acme.okta.com', gatewayUrl: DEMO.settings.gatewayUrl, clientId: 'cid', clientSecret: 'csec' });
  assert.equal(toTenant({ settings: {}, oidc_configuration: DEMO.oidc_configuration }), null);
  assert.equal(toTenant({ settings: DEMO.settings, oidc_configuration: { issuer: 'x' } }), null);
  assert.equal(toTenant(null), null);
});

test('hooks: both payload shapes and both delete spellings normalise the same way', () => {
  const guide = normalize('create', { event: { type: 'create', callback: 'https://api.demo.okta.com/demonstration/lifecycle/1' }, demonstration: { name: 'My-Demo' }, idp: { type: 'workforce-identity' }, component: { settings: { a: 1 }, oidcConfiguration: { client_id: 'c' } } });
  const qs = normalize('destroy', { demonstration: { name: 'my-demo' }, application: { settings: { a: 1 }, oidc_configuration: { client_id: 'c' } } });
  assert.equal(guide.demoName, 'my-demo'); assert.equal(guide.type, 'create'); assert.equal(qs.type, 'delete');
  assert.deepEqual(guide.oidc, qs.oidc); assert.equal(qs.callback, null);
});

test('hooks: only https callbacks on the platform host are allowed', () => {
  assert.equal(callbackAllowed('https://api.demo.okta.com/demonstration/lifecycle/abc'), true);
  for (const bad of ['http://api.demo.okta.com/x', 'https://evil.com/x', 'https://api.demo.okta.com.evil.com/x', 'https://api.demo.okta.com:8443/x', 'https://u:p@api.demo.okta.com/x', 'nope', '']) assert.equal(callbackAllowed(bad), false, bad);
});

async function hookServer(opts = {}) {
  const p = fakePlatform({ demos: { 'my-demo': DEMO } }); const bootstrap = mk(p); const pending = []; const log = [];
  const app = express(); app.use('/hooks', createHooks({ bootstrap, fetchImpl: p.fetchImpl, defer: (x) => pending.push(x.catch(() => {})), log: (m, d) => log.push([m, d]), ...opts }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const post = (path, body) => fetch(`http://127.0.0.1:${srv.address().port}/hooks/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, p, pending, log, bootstrap, close: () => new Promise((r) => srv.close(r)) };
}
const CB = 'https://api.demo.okta.com/demonstration/lifecycle/abc';

test('hooks: a genuine create is acknowledged with 202, then reported finished to the callback', async () => {
  const h = await hookServer();
  try {
    const r = await h.post('create', { event: { callback: CB }, demonstration: { name: 'my-demo' } });
    assert.equal(r.status, 202); await Promise.all(h.pending);
    assert.deepEqual(h.p.calls.patched, [{ url: CB, body: { state: 'finish', message: 'Agent Gateway demo configured' } }]);
    assert.ok(h.log.some(([m]) => /tenant changes disabled/.test(m)), 'nothing is modified while the flag is off');
  } finally { await h.close(); }
});

test('hooks: the form\'s attach and detach URLs are served like create and delete', async () => {
  const h = await hookServer();
  try {
    assert.equal((await h.post('attach', { event: { callback: CB }, demonstration: { name: 'my-demo' } })).status, 202); await Promise.all(h.pending);
    assert.equal(h.p.calls.patched[0].body.state, 'finish');
    await h.bootstrap.get('my-demo'); assert.equal(h.bootstrap.cacheSize(), 1);
    assert.equal((await h.post('detach', { demonstration: { name: 'my-demo' } })).status, 202); await Promise.all(h.pending);
    assert.equal(h.bootstrap.cacheSize(), 0);
  } finally { await h.close(); }
});

test('hooks: a forged create for a demo the platform does not know is refused and reports failure', async () => {
  const h = await hookServer();
  try {
    assert.equal((await h.post('create', { event: { callback: CB }, demonstration: { name: 'ghost' } })).status, 202); await Promise.all(h.pending);
    assert.equal(h.p.calls.patched[0].body.state, 'fail');
  } finally { await h.close(); }
});

test('hooks: a callback pointing anywhere else is never contacted', async () => {
  const h = await hookServer();
  try {
    await h.post('create', { event: { callback: 'https://evil.example.net/steal' }, demonstration: { name: 'my-demo' } }); await Promise.all(h.pending);
    assert.equal(h.p.calls.patched, undefined);
  } finally { await h.close(); }
});

test('hooks: malformed names and unknown events are rejected; delete and update evict the cache', async () => {
  const h = await hookServer();
  try {
    assert.equal((await h.post('create', { demonstration: { name: '../etc' } })).status, 400);
    assert.equal((await h.post('create', {})).status, 400);
    assert.equal((await h.post('bogus', { demonstration: { name: 'my-demo' } })).status, 404);
    await h.bootstrap.get('my-demo'); assert.equal(h.bootstrap.cacheSize(), 1);
    await h.post('destroy', { demonstration: { name: 'my-demo' } }); await Promise.all(h.pending);
    assert.equal(h.bootstrap.cacheSize(), 0);
  } finally { await h.close(); }
});

test('hooks: tenant changes run only when switched on, and a failing action reports failure', async () => {
  const ran = []; const h = await hookServer({ tenantChanges: true, actions: { create: async (ev) => { ran.push(ev.demoName); throw new Error('boom'); } } });
  try {
    await h.post('create', { event: { callback: CB }, demonstration: { name: 'my-demo' } }); await Promise.all(h.pending);
    assert.deepEqual(ran, ['my-demo']); assert.deepEqual(h.p.calls.patched[0].body, { state: 'fail', message: 'boom' });
  } finally { await h.close(); }
});

test('multi-tenant app: demos are resolved through the tenant lookup and webhooks bypass the session', async () => {
  const p = fakePlatform({ demos: { 'my-demo': DEMO } }); const bootstrap = mk(p);
  const app = await startApp({ gatewayUrl: undefined, resolution: { strategy: 'query' },
    getTenant: async (n) => toTenant(await bootstrap.get(n)), hooks: createHooks({ bootstrap, fetchImpl: p.fetchImpl, defer: (x) => x.catch(() => {}) }) });
  try {
    const b = browser(app.base);
    assert.equal((await b('/api/config?demoName=ghost')).status, 404);
    const ok = await b('/api/config?demoName=my-demo'); assert.equal(ok.status, 200);
    assert.equal((await ok.json()).gatewayUrl, DEMO.settings.gatewayUrl);
    const hook = await fetch(app.base + '/hooks/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ demonstration: { name: 'my-demo' } }) });
    assert.equal(hook.status, 202); assert.equal(hook.headers.get('set-cookie'), null);
  } finally { await app.close(); }
});

test('toTenant accepts only an https Okta gateway address in the pasted setting', () => {
  const ok = 'https://demo-agent-gateway.gateway.oktapreview.com/mcp/servers/agent-gateway-agent-gateway';
  assert.equal(validGatewayUrl(`  ${ok} `), ok);
  for (const bad of ['http://a.gateway.oktapreview.com/mcp/x', 'https://169.254.169.254/mcp/x', 'https://localhost/mcp/x', 'https://evil.example.com/mcp/x',
    'https://a.oktapreview.com.evil.com/mcp/x', 'https://u:p@a.oktapreview.com/mcp/x', 'https://a.oktapreview.com:8443/mcp/x', 'https://a.oktapreview.com/', 'not a url', '', undefined]) {
    assert.equal(validGatewayUrl(bad), null, String(bad));
  }
  assert.equal(toTenant({ ...DEMO, settings: { gatewayUrl: 'https://evil.example.com/mcp/x' } }), null);
});
