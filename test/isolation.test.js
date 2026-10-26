import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, browser } from './helpers.js';

// A stand-in gateway: 401 with a metadata pointer, then protected-resource and authorization-server metadata.
function stubGateway() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${s.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/pr"`); return res.end('{}'); }
      if (req.url === '/pr') return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['openid'] }));
      if (req.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'] }));
      res.statusCode = 404; res.end('{}');
    });
    s.listen(0, () => resolve({ url: `http://127.0.0.1:${s.address().port}/mcp`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
  });
}

// Reads whatever the SSE stream sends for a short window.
async function readEvents(b, path = '/api/events?after=0', ms = 400) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const out = [];
  try {
    const res = await b(path, { signal: ctl.signal });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      for (const m of buf.split('\n\n').slice(0, -1)) if (m.startsWith('data:')) out.push(JSON.parse(m.slice(5)));
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  } catch { /* aborted at the end of the window */ }
  clearTimeout(timer);
  return out;
}

test('one visitor never sees another visitor’s trace', async () => {
  const gw = await stubGateway();
  const app = await startApp({ gatewayUrl: gw.url });
  try {
    const alice = browser(app.base), bob = browser(app.base);
    await alice('/api/config'); await bob('/api/config');
    const r = await alice('/api/discover', { method: 'POST' });
    assert.equal(r.status, 200);
    const a = await readEvents(alice), b = await readEvents(bob);
    assert.ok(a.length >= 3, `alice should see her own 3 discovery calls, saw ${a.length}`);
    assert.equal(b.length, 0, 'bob must see nothing from alice');
  } finally { await app.close(); await gw.close(); }
});

test('clear and logout only affect the caller’s trace', async () => {
  const gw = await stubGateway();
  const app = await startApp({ gatewayUrl: gw.url });
  try {
    const alice = browser(app.base), bob = browser(app.base);
    await alice('/api/discover', { method: 'POST' });
    await bob('/api/discover', { method: 'POST' });
    await alice('/api/events/clear', { method: 'POST' });
    assert.equal((await readEvents(alice)).length, 0, 'alice cleared hers');
    assert.ok((await readEvents(bob)).length >= 3, 'bob’s trace is intact after alice cleared');
    await alice('/api/logout', { method: 'POST' });
    assert.ok((await readEvents(bob)).length >= 3, 'bob’s trace is intact after alice logged out');
  } finally { await app.close(); await gw.close(); }
});

test('live events go only to the stream of the session that caused them', async () => {
  const gw = await stubGateway();
  const app = await startApp({ gatewayUrl: gw.url });
  try {
    const alice = browser(app.base), bob = browser(app.base);
    await alice('/api/config'); await bob('/api/config');
    const bobStream = readEvents(bob, '/api/events', 1200);   // no ?after: live only
    await new Promise((r) => setTimeout(r, 200));
    await alice('/api/discover', { method: 'POST' });
    assert.equal((await bobStream).length, 0, 'bob’s live stream must not receive alice’s events');
  } finally { await app.close(); await gw.close(); }
});
