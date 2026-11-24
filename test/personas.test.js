import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { personasFromEnv, publicPersona } from '../personas.js';
import { startApp, browser } from './helpers.js';

const ENV = {
  GATEWAY_URL: 'https://org.gateway.oktapreview.com/mcp/servers/eng', CLIENT_ID: 'https://claude.ai/oauth/claude-code-client-metadata',
  SALES_AGENT_CLIENT_ID: 'wlpSALES', SALES_AGENT_CLIENT_SECRET: 'sales-secret-value', HR_AGENT_CLIENT_ID: 'wlpHR', HR_AGENT_CLIENT_SECRET: 'hr-secret-value',
};

test('personas are built from the environment, one gateway per team', () => {
  const [ethan, sofia, hannah] = personasFromEnv(ENV);
  assert.deepEqual([ethan, sofia, hannah].map((p) => p.configured), [true, true, true]);
  assert.equal(sofia.gatewayUrl, 'https://org.gateway.oktapreview.com/mcp/servers/sales-tools');
  assert.equal(hannah.gatewayUrl, 'https://org.gateway.oktapreview.com/mcp/servers/hr-resources');
  // Engineering uses the public Claude Code client: no secret, and the /callback path that client registered.
  assert.equal(ethan.clientSecret, undefined);
  assert.equal(ethan.callbackPath, '/callback');
  assert.equal(sofia.callbackPath, '/authorization-code/callback');
});

test('a persona with missing settings is reported as not set up', () => {
  const p = personasFromEnv({ ...ENV, SALES_AGENT_CLIENT_SECRET: undefined });
  assert.equal(p.find((x) => x.key === 'sofia').configured, false);
  assert.equal(p.find((x) => x.key === 'hannah').configured, true);
});

test('what the browser may see never includes a client secret', () => {
  const shown = JSON.stringify(personasFromEnv(ENV).map(publicPersona));
  assert.ok(!shown.includes('sales-secret-value') && !shown.includes('hr-secret-value') && !/clientSecret/.test(shown));
});

// One stub plays both teams' gateways and authorization servers.
function stub() {
  const seen = { tokenForms: [] };
  const jwt = (claims) => ['{"alg":"none"}', JSON.stringify(claims), 'x'].map((p, i) => (i === 2 ? p : Buffer.from(p).toString('base64url'))).join('.');
  return new Promise((resolve) => {
    const s = http.createServer((rq, res) => {
      const base = `http://127.0.0.1:${s.address().port}`;
      let body = ''; rq.on('data', (c) => (body += c)); rq.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (rq.url === '/token') { seen.tokenForms.push(Object.fromEntries(new URLSearchParams(body))); return res.end(JSON.stringify({ access_token: jwt({ sub: 'sofia', aud: 'x' }), token_type: 'Bearer', expires_in: 3600 })); }
        if (rq.method === 'POST') { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/a"`); return res.end('{}'); }
        if (rq.url.startsWith('/.well-known/oauth-protected-resource')) return res.end(JSON.stringify({ resource: `${base}/mcp/a`, authorization_servers: [base], scopes_supported: ['openid'] }));
        if (rq.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] }));
        res.statusCode = 404; res.end('{}');
      });
    });
    s.listen(0, () => { const url = `http://127.0.0.1:${s.address().port}`; resolve({ seen, url, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }); });
  });
}
const personasFor = (url) => [
  { key: 'ethan', name: 'Ethan Park', department: 'Engineering', login: 'ethan@x.test', agent: 'Engineering Agent', gatewayLabel: 'Engineering Tools', gatewayUrl: `${url}/mcp/a`, clientId: 'client-eng', clientSecret: 'eng-secret', callbackPath: '/authorization-code/callback', configured: true, blockedTools: [{ name: 'GitHubMCP_delete_file', label: 'delete_file' }] },
  { key: 'sofia', name: 'Sofia Reyes', department: 'Sales', login: 'sofia@x.test', agent: 'Sales Agent', gatewayLabel: 'Sales Tools', gatewayUrl: `${url}/mcp/b`, clientId: 'client-sales', clientSecret: 'sales-secret', callbackPath: '/authorization-code/callback', configured: true, blockedTools: [] },
  { key: 'hannah', name: 'Hannah Cho', department: 'HR', login: 'hannah@x.test', agent: 'HR Agent', gatewayLabel: 'HR Resources', gatewayUrl: `${url}/mcp/c`, clientId: 'client-hr', callbackPath: '/authorization-code/callback', configured: false, blockedTools: [] },
];
const post = (b, path, body) => b(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('choosing a persona switches the agent and gateway, and bad choices are refused', async () => {
  const st = await stub();
  const app = await startApp({ personas: personasFor(st.url) });
  try {
    const b = browser(app.base);
    const before = await (await b('/api/config')).json();
    assert.equal(before.persona, null);
    assert.equal(before.personas.length, 3);
    assert.ok(!JSON.stringify(before).includes('eng-secret'));
    assert.equal((await post(b, '/api/persona', { key: 'nobody' })).status, 400);
    assert.equal((await post(b, '/api/persona', { key: 'hannah' })).status, 400); // not set up
    assert.equal((await post(b, '/api/persona', { key: 'sofia' })).status, 200);
    const after = await (await b('/api/config')).json();
    assert.equal(after.persona, 'sofia');
    assert.equal(after.gatewayUrl, `${st.url}/mcp/b`);
    assert.equal((await post(b, '/api/persona', { key: null })).status, 200);
    assert.equal((await (await b('/api/config')).json()).persona, null);
  } finally { await app.close(); await st.close(); }
});

test('signing in as a persona uses its own client, pre-fills its username and forces a fresh login', async () => {
  const st = await stub();
  const app = await startApp({ personas: personasFor(st.url) });
  try {
    const b = browser(app.base);
    await post(b, '/api/persona', { key: 'sofia' });
    await post(b, '/api/discover', {});
    const u = new URL((await b('/auth/login')).headers.get('location'));
    assert.equal(u.searchParams.get('client_id'), 'client-sales');
    assert.equal(u.searchParams.get('login_hint'), 'sofia@x.test');
    assert.equal(u.searchParams.get('prompt'), 'login');
    assert.equal(u.searchParams.get('resource'), `${st.url}/mcp/b`);
  } finally { await app.close(); await st.close(); }
});

test('trying another team’s agent asks Okta for that agent, keeps the session, and records the refusal', async () => {
  const st = await stub();
  const app = await startApp({ personas: personasFor(st.url).map((p) => (p.key === 'hannah' ? { ...p, configured: true, clientSecret: 'hr-secret' } : p)) });
  try {
    const b = browser(app.base);
    await post(b, '/api/persona', { key: 'sofia' });
    assert.equal((await b('/auth/probe/ethan')).status, 400); // not signed in yet
    await post(b, '/api/discover', {});
    const login = new URL((await b('/auth/login')).headers.get('location'));
    await b(`/authorization-code/callback?code=abc&state=${login.searchParams.get('state')}`);
    assert.equal((await (await b('/api/config')).json()).signedIn, true);
    assert.equal((await b('/auth/probe/sofia')).status, 400); // her own agent is not "another team's"
    const probe = new URL((await b('/auth/probe/ethan')).headers.get('location'));
    assert.equal(probe.searchParams.get('client_id'), 'client-eng');
    assert.equal(probe.searchParams.get('resource'), `${st.url}/mcp/a`);
    assert.equal(probe.searchParams.get('prompt'), null);
    assert.equal(probe.searchParams.get('login_hint'), null);
    const formsBefore = st.seen.tokenForms.length;
    await b(`/authorization-code/callback?error=access_denied&error_description=${encodeURIComponent('User is not assigned to the client application.')}&state=${probe.searchParams.get('state')}`);
    const cfg = await (await b('/api/config')).json();
    assert.equal(cfg.signedIn, true);                                  // the persona's own session survived
    assert.equal(st.seen.tokenForms.length, formsBefore);              // and nothing was exchanged for the refused agent
    const feed = await (await b('/api/events/poll?after=0')).json();
    const refusal = (feed.events || feed).find((e) => /refused .* access to the Engineering Agent/.test(e.label));
    assert.ok(refusal, 'the refusal is in the trace');
    assert.equal(refusal.outcome, 'denied');
    assert.equal(refusal.verdict.kind, 'blocked-okta');
    assert.deepEqual(refusal.verdict.target, { agent: 'Engineering Agent', gateway: 'Engineering Tools' });
  } finally { await app.close(); await st.close(); }
});

test('choosing a persona reports where the event numbering stands, so an open page can resume after a server restart', async () => {
  const st = await stub();
  const app = await startApp({ personas: personasFor(st.url) });
  try {
    const b = browser(app.base);
    const first = await (await post(b, '/api/persona', { key: 'sofia' })).json();
    assert.equal(first.head, 0);                                   // a brand-new session starts at zero
    await post(b, '/api/discover', {});                            // three events
    const again = await (await post(b, '/api/persona', { key: 'ethan' })).json();
    assert.equal(again.head, 3);                                   // numbering continues, it is not reset
    const cleared = await (await post(b, '/api/events/clear', {})).json();
    assert.equal(cleared.head, 3);
  } finally { await app.close(); await st.close(); }
});
