import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { safeUrl, redactUrl } from '../server.js';
import { startApp, browser } from './helpers.js';

test('safeUrl accepts public https and rejects everything that could reach inside a network', () => {
  for (const ok of ['https://acme.okta.com/oauth2/aus1', 'https://login.example.org:8443/x', 'https://8.8.8.8/x', 'https://172.32.0.1/x']) assert.ok(safeUrl(ok), ok);
  const bad = ['http://acme.okta.com/x', 'ftp://acme.okta.com', 'https://localhost/x', 'https://app.localhost/x', 'https://127.0.0.1/x', 'https://127.1.2.3/x',
    'https://10.0.0.5/x', 'https://172.16.0.1/x', 'https://172.31.255.255/x', 'https://192.168.1.1/x', 'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/x', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x', 'https://[::ffff:10.0.0.1]/x',
    'https://box.internal/x', 'https://printer.local/x', 'https://user:pw@acme.okta.com/x', 'https://2130706433/x', 'https://0x7f000001/x', 'not a url', ''];
  for (const b of bad) assert.equal(safeUrl(b), null, b);
});

test('safeUrl in local-development mode allows plain http and loopback but still rejects other schemes', () => {
  assert.ok(safeUrl('http://127.0.0.1:9000/x', { allowLocal: true }));
  assert.ok(safeUrl('http://localhost:9000/x', { allowLocal: true }));
  assert.equal(safeUrl('file:///etc/passwd', { allowLocal: true }), null);
  assert.equal(safeUrl('javascript:alert(1)', { allowLocal: true }), null);
});

test('redactUrl hides the one-time code and state but keeps the path and other parameters', () => {
  const out = redactUrl('/authorization-code/callback?code=abcdefghijklmnopqrstuvwxyz&state=0123456789abcdef0123456789abcdef&other=ok');
  assert.ok(out.startsWith('/authorization-code/callback?'));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz') && !out.includes('0123456789abcdef0123456789abcdef'));
  assert.ok(out.includes('other=ok'));
  assert.equal(redactUrl('/authorization-code/callback'), '/authorization-code/callback');
});

// A gateway that advertises whatever authorization server we tell it to.
function gateway(meta) {
  return new Promise((resolve) => {
    const s = http.createServer((rq, res) => {
      const base = `http://127.0.0.1:${s.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (rq.method === 'POST') { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/pr"`); return res.end('{}'); }
      if (rq.url === '/pr') return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [meta.as(base)], scopes_supported: ['openid'] }));
      if (rq.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify(meta.asDoc(base)));
      res.statusCode = 404; res.end('{}');
    });
    s.listen(0, () => resolve({ url: `http://127.0.0.1:${s.address().port}/mcp`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
  });
}

test('a gateway whose token endpoint is on a different host cannot collect the client secret', async () => {
  const gw = await gateway({ as: (b) => b, asDoc: (b) => ({ issuer: b, authorization_endpoint: `${b}/authorize`, token_endpoint: 'http://169.254.169.254/steal', code_challenge_methods_supported: ['S256'] }) });
  const app = await startApp({ gatewayUrl: gw.url });
  try {
    const b = browser(app.base);
    const r = await (await b('/api/discover', { method: 'POST' })).json();
    assert.equal(r.ok, false);
    assert.equal((await b('/auth/login')).status, 409, 'login must stay locked');
  } finally { await app.close(); await gw.close(); }
});

test('production mode refuses a plain-http or private authorization server outright', async () => {
  const gw = await gateway({ as: (b) => b, asDoc: (b) => ({ issuer: b, authorization_endpoint: `${b}/a`, token_endpoint: `${b}/t` }) });
  const app = await startApp({ gatewayUrl: gw.url, allowLocal: false });
  try {
    const res = await browser(app.base)('/api/discover', { method: 'POST' });
    assert.equal(res.status, 502);
  } finally { await app.close(); await gw.close(); }
});

test('the config endpoint no longer echoes org, client id or redirect URI, and responses are not cacheable', async () => {
  const app = await startApp();
  try {
    const res = await fetch(app.base + '/api/config');
    const body = await res.json();
    for (const k of ['orgUrl', 'clientId', 'redirectUri', 'clientSecret']) assert.ok(!(k in body), k);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(app.base + '/api/flow')).headers.get('cache-control'), 'no-store');
  } finally { await app.close(); }
});

test('static assets do not create a session', async () => {
  const app = await startApp();
  try {
    for (const p of ['/app.js', '/styles.css']) {
      const res = await fetch(app.base + p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('set-cookie'), null, p);
    }
    const page = await fetch(app.base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('set-cookie') || '', /connect\.sid=/);
  } finally { await app.close(); }
});
