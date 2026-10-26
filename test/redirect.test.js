import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, browser } from './helpers.js';

// Gateway stub that also records what the token endpoint receives.
function gateway() {
  const seen = { tokenForms: [] };
  return new Promise((resolve) => {
    const s = http.createServer((rq, res) => {
      const base = `http://127.0.0.1:${s.address().port}`;
      let body = ''; rq.on('data', (c) => (body += c)); rq.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (rq.url === '/token') { seen.tokenForms.push(Object.fromEntries(new URLSearchParams(body))); res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
        if (rq.method === 'POST') { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/pr"`); return res.end('{}'); }
        if (rq.url === '/pr') return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['openid'] }));
        if (rq.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] }));
        res.statusCode = 404; res.end('{}');
      });
    });
    s.listen(0, () => resolve({ seen, url: `http://127.0.0.1:${s.address().port}/mcp`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
  });
}

// fetch() will not let us set Host, so use http.request to prove a spoofed Host header is ignored.
function rawGet(base, path, host, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = http.request({ host: u.hostname, port: u.port, path, headers: { host, 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    r.on('error', reject); r.end();
  });
}

test('the redirect URI comes from configuration, never from the Host header', async () => {
  const gw = await gateway();
  const app = await startApp({ gatewayUrl: gw.url, origin: 'https://demo.example.com', trustProxy: 1 });
  try {
    // one discovered session, then ask for login with an honest Host and with a spoofed one
    const disc = await fetch(app.base + '/api/discover', { method: 'POST', headers: { 'x-forwarded-proto': 'https' } });
    const cookie = disc.headers.getSetCookie()[0].split(';')[0];
    const honest = await rawGet(app.base, '/auth/login', new URL(app.base).host, cookie);
    const spoofed = await rawGet(app.base, '/auth/login', 'evil.example.net', cookie);
    for (const r of [honest, spoofed]) {
      assert.equal(r.statusCode, 302);
      assert.equal(new URL(r.headers.location).searchParams.get('redirect_uri'), 'https://demo.example.com/authorization-code/callback');
      assert.ok(!r.headers.location.includes('evil.example.net'));
    }
  } finally { await app.close(); await gw.close(); }
});

test('the token exchange sends exactly the redirect_uri that /authorize used', async () => {
  const gw = await gateway();
  const app = await startApp({ gatewayUrl: gw.url, origin: 'https://demo.example.com', trustProxy: 1 });
  try {
    const b = browser(app.base, { 'x-forwarded-proto': 'https' });
    await b('/api/discover', { method: 'POST' });
    const login = await b('/auth/login');
    const u = new URL(login.headers.get('location'));
    const sent = u.searchParams.get('redirect_uri');
    await b(`/authorization-code/callback?code=abc&state=${u.searchParams.get('state')}`);
    assert.equal(gw.seen.tokenForms.length, 1, 'token endpoint should be called once');
    assert.equal(gw.seen.tokenForms[0].redirect_uri, sent);
    assert.equal(gw.seen.tokenForms[0].code, 'abc');
    assert.equal(gw.seen.tokenForms[0].client_id, 'test-client');
  } finally { await app.close(); await gw.close(); }
});

test('a wrong state is refused without calling the token endpoint', async () => {
  const gw = await gateway();
  const app = await startApp({ gatewayUrl: gw.url });
  try {
    const b = browser(app.base);
    await b('/api/discover', { method: 'POST' });
    await b('/auth/login');
    await b('/authorization-code/callback?code=abc&state=not-the-state');
    assert.equal(gw.seen.tokenForms.length, 0);
  } finally { await app.close(); await gw.close(); }
});

test('with an https public address, no session cookie is issued over plain http (secure cookie)', async () => {
  const app = await startApp({ origin: 'https://demo.example.com' });
  try {
    const res = await fetch(app.base + '/api/config');
    assert.equal(res.headers.get('set-cookie'), null);
  } finally { await app.close(); }
});

test('a tenant that registered /callback is sent there and the callback route answers on it', async () => {
  const gw = await gateway();
  const tenant = { orgUrl: 'https://acme.okta.com', gatewayUrl: gw.url, clientId: 'cid', clientSecret: 's', callbackPath: '/callback' };
  const app = await startApp({ origin: 'https://demo.example.com', trustProxy: 1, getTenant: async () => tenant });
  try {
    const b = browser(app.base, { 'x-forwarded-proto': 'https' });
    await b('/api/discover', { method: 'POST' });
    const login = await b('/auth/login');
    const u = new URL(login.headers.get('location'));
    assert.equal(u.searchParams.get('redirect_uri'), 'https://demo.example.com/callback');
    const back = await b(`/callback?code=abc&state=${u.searchParams.get('state')}`);
    assert.equal(back.status, 302);
  } finally { await app.close(); await gw.close(); }
});

test('the CIMD document is public, names itself as client_id and lists the platform callback', async () => {
  const gw = await gateway();
  const app = await startApp({ gatewayUrl: gw.url, origin: 'https://demo.example.com', trustProxy: 1 });
  try {
    const r = await fetch(app.base + '/cimd.json');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('set-cookie'), null);
    const d = await r.json();
    assert.equal(d.client_id, 'https://demo.example.com/cimd.json');
    assert.deepEqual(d.redirect_uris, ['https://demo.example.com/callback']);
    assert.equal(d.token_endpoint_auth_method, 'none');
    assert.ok(!('client_secret' in d));
  } finally { await app.close(); await gw.close(); }
});
