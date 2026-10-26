import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, browser } from './helpers.js';
import { createRedisStore } from '../store.js';
import { fakeRedis } from './fakeRedis.js';

function gateway() {
  return new Promise((resolve) => {
    const s = http.createServer((rq, res) => {
      const base = `http://127.0.0.1:${s.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (rq.method === 'POST') { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/pr"`); return res.end('{}'); }
      if (rq.url === '/pr') return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['openid'] }));
      if (rq.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/a`, token_endpoint: `${base}/t` }));
      res.statusCode = 404; res.end('{}');
    });
    s.listen(0, () => resolve({ url: `http://127.0.0.1:${s.address().port}/mcp`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
  });
}

for (const [name, store] of [['memory', () => undefined], ['redis', () => createRedisStore(fakeRedis())]]) {
  test(`poll (${name} store): a fresh load starts empty, then returns only new events, and visitors stay separate`, async () => {
    const gw = await gateway(); const app = await startApp({ gatewayUrl: gw.url, transport: 'poll', store: store() });
    try {
      assert.equal((await (await fetch(app.base + '/api/transport')).json()).mode, 'poll');
      const alice = browser(app.base), bob = browser(app.base);
      const init = await (await alice('/api/events/poll?init=1')).json();
      assert.deepEqual(init, { events: [], head: 0 });
      await bob('/api/events/poll?init=1');
      await alice('/api/discover', { method: 'POST' });
      const first = await (await alice(`/api/events/poll?after=${init.head}`)).json();
      assert.ok(first.events.length >= 3); assert.equal(first.head, first.events.at(-1).id);
      const again = await (await alice(`/api/events/poll?after=${first.head}`)).json();
      assert.deepEqual(again.events, [], 'nothing new the second time');
      assert.deepEqual((await (await bob(`/api/events/poll?after=0`)).json()).events, [], 'bob sees none of alice’s events');
      await alice('/api/events/clear', { method: 'POST' });
      assert.deepEqual((await (await alice('/api/events/poll?after=0')).json()).events, []);
    } finally { await app.close(); await gw.close(); }
  });
}

test('the stream still works on the shared store, and a store failure gives a clean 500 instead of a hang', async () => {
  const gw = await gateway(); const store = createRedisStore(fakeRedis());
  const app = await startApp({ gatewayUrl: gw.url, store });
  try {
    const b = browser(app.base);
    await b('/api/discover', { method: 'POST' });
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 500); const got = [];
    try { const res = await b('/api/events?after=0', { signal: ctl.signal }); const dec = new TextDecoder(); let buf = '';
      for await (const c of res.body) { buf += dec.decode(c, { stream: true }); for (const m of buf.split('\n\n').slice(0, -1)) if (m.startsWith('data:')) got.push(JSON.parse(m.slice(5))); buf = buf.slice(buf.lastIndexOf('\n\n') + 2); } } catch { /* window over */ }
    assert.ok(got.length >= 3, `replayed ${got.length}`);
    const ids = got.map((e) => e.id); assert.deepEqual(ids, [...ids].sort((a, c) => a - c)); assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  } finally { await app.close(); await gw.close(); }

  const broken = { ...createRedisStore(fakeRedis()), list: async () => { throw new Error('redis down'); }, head: async () => { throw new Error('redis down'); } };
  const app2 = await startApp({ store: broken });
  try {
    const res = await Promise.race([fetch(app2.base + '/api/events/poll?after=0'), new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 3000))]);
    assert.equal(res.status, 500); assert.deepEqual(await res.json(), { error: 'Something went wrong' });
  } finally { await app2.close(); }
});
