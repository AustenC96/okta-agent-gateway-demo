import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tenantNameFrom } from '../tenant.js';
import { startApp, browser } from './helpers.js';

const req = (o) => ({ query: {}, headers: {}, ...o });

test('tenantNameFrom: none ignores everything', () => {
  assert.deepEqual(tenantNameFrom(req({ query: { demoName: 'x' } }), { strategy: 'none' }), { name: null });
});

test('tenantNameFrom: query strategy', () => {
  const o = { strategy: 'query' };
  assert.deepEqual(tenantNameFrom(req({ query: { demoName: 'My-Demo' } }), o), { name: 'my-demo' });
  assert.deepEqual(tenantNameFrom(req({}), o), { name: null });
  for (const bad of ['../etc', 'a b', '-lead', 'x'.repeat(64), 'a/b', '<script>']) assert.deepEqual(tenantNameFrom(req({ query: { demoName: bad } }), o), { invalid: true }, bad);
  assert.deepEqual(tenantNameFrom(req({ query: { demoName: ['a', 'b'] } }), o), { invalid: true });
});

test('tenantNameFrom: subdomain strategy', () => {
  const o = { strategy: 'subdomain', baseHost: 'app.example.com' };
  assert.deepEqual(tenantNameFrom(req({ headers: { host: 'my-demo.app.example.com' } }), o), { name: 'my-demo' });
  assert.deepEqual(tenantNameFrom(req({ headers: { host: 'my-demo.app.example.com:3000' } }), o), { name: 'my-demo' });
  assert.deepEqual(tenantNameFrom(req({ headers: { host: 'app.example.com' } }), o), { name: null });
  assert.deepEqual(tenantNameFrom(req({ headers: { host: 'evil.com' } }), o), { invalid: true });
  assert.deepEqual(tenantNameFrom(req({ headers: { host: 'a.b.app.example.com' } }), o), { invalid: true });
});

// A gateway stub that reports who it is, so we can tell whose discovery answered.
function gateway(label) {
  return new Promise((resolve) => {
    const s = http.createServer((rq, res) => {
      const base = `http://127.0.0.1:${s.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (rq.method === 'POST') { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/pr"`); return res.end('{}'); }
      if (rq.url === '/pr') return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [label] }));
      if (rq.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ issuer: `${base}#${label}`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] }));
      res.statusCode = 404; res.end('{}');
    });
    s.listen(0, () => resolve({ url: `http://127.0.0.1:${s.address().port}/mcp`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
  });
}

async function twoTenantApp() {
  const [ga, gb] = [await gateway('alpha'), await gateway('beta')];
  const tenants = { alpha: { orgUrl: 'https://a.example.com', gatewayUrl: ga.url, clientId: 'ca', clientSecret: 'sa' }, beta: { orgUrl: 'https://b.example.com', gatewayUrl: gb.url, clientId: 'cb', clientSecret: 'sb' } };
  const app = await startApp({ gatewayUrl: undefined, resolution: { strategy: 'query' }, getTenant: async (n) => tenants[n] || null });
  return { app, close: async () => { await app.close(); await ga.close(); await gb.close(); } };
}

test('unknown and malformed demo names are rejected', async () => {
  const { app, close } = await twoTenantApp();
  try {
    const b = browser(app.base);
    assert.equal((await b('/api/config?demoName=nope')).status, 404);
    assert.equal((await b('/api/config?demoName=../x')).status, 400);
    assert.equal((await b('/api/config?demoName=alpha')).status, 200);
  } finally { await close(); }
});

test('each tenant has its own discovery results', async () => {
  const { app, close } = await twoTenantApp();
  try {
    const b = browser(app.base);
    await b('/api/discover?demoName=alpha', { method: 'POST' });
    const alpha = await (await b('/api/flow?demoName=alpha')).json();
    assert.match(alpha.nodes.discover.data.authorization_server, /#alpha$/);
    // beta has not been discovered yet, even though alpha has
    const beta = await (await b('/api/flow?demoName=beta')).json();
    assert.equal(beta.nodes.discover.status, 'idle');
    assert.equal((await b('/auth/login?demoName=beta')).status, 409);
    await b('/api/discover?demoName=beta', { method: 'POST' });
    assert.match((await (await b('/api/flow?demoName=beta')).json()).nodes.discover.data.authorization_server, /#beta$/);
  } finally { await close(); }
});

test('the cookie remembers the demo, and switching demos drops the previous sign-in state', async () => {
  const { app, close } = await twoTenantApp();
  try {
    const b = browser(app.base);
    const c1 = await (await b('/api/config?demoName=alpha')).json();
    assert.equal(c1.gatewayUrl, (await (await b('/api/config')).json()).gatewayUrl, 'no demoName reuses the session’s demo');
    await b('/api/discover', { method: 'POST' });
    assert.equal((await (await b('/api/config')).json()).discovered, true);
    const c2 = await (await b('/api/config?demoName=beta')).json();
    assert.notEqual(c2.gatewayUrl, c1.gatewayUrl);
    assert.equal(c2.discovered, false, 'beta must not inherit alpha’s discovered flag');
  } finally { await close(); }
});

test('the OAuth callback cannot be pointed at a different demo', async () => {
  const { app, close } = await twoTenantApp();
  try {
    const b = browser(app.base);
    await b('/api/discover?demoName=alpha', { method: 'POST' });
    const login = await b('/auth/login');
    assert.equal(login.status, 302);
    assert.match(login.headers.get('location'), /client_id=ca/);
    // an attacker-supplied demoName on the callback is ignored: the session's own demo is used
    await b('/authorization-code/callback?demoName=beta&code=x&state=wrong');
    assert.equal((await (await b('/api/config')).json()).gatewayUrl, (await (await b('/api/config?demoName=alpha')).json()).gatewayUrl);
  } finally { await close(); }
});
