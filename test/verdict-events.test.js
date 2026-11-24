import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, browser } from './helpers.js';

// A stand-in for one gateway plus its Okta authorization server, speaking just enough MCP.
function stub() {
  const jwt = (c) => ['{"alg":"none"}', JSON.stringify(c), 'x'].map((p, i) => (i === 2 ? p : Buffer.from(p).toString('base64url'))).join('.');
  return new Promise((resolve) => {
    const s = http.createServer((rq, res) => {
      const base = `http://127.0.0.1:${s.address().port}`;
      let body = ''; rq.on('data', (c) => (body += c)); rq.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (rq.url === '/token') return res.end(JSON.stringify({ access_token: jwt({ sub: 'sofia', aud: 'x' }), token_type: 'Bearer', expires_in: 3600 }));
        if (rq.url.startsWith('/.well-known/oauth-protected-resource')) return res.end(JSON.stringify({ resource: `${base}/mcp/b`, authorization_servers: [base], scopes_supported: ['openid'] }));
        if (rq.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] }));
        if (rq.method !== 'POST') { res.statusCode = 404; return res.end('{}'); }
        if (!rq.headers.authorization) { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/b"`); return res.end('{}'); }
        const rpc = JSON.parse(body || '{}');
        const reply = (r) => res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...r }));
        if (rpc.method === 'notifications/initialized') { res.statusCode = 202; return res.end(''); }
        if (rpc.method === 'initialize') return reply({ result: { serverInfo: { name: 'stub' }, capabilities: { tools: {} } } });
        if (rpc.method === 'tools/list') return reply({ result: { tools: [{ name: 'CRMMCP_get_customer', annotations: { readOnlyHint: true } }, { name: 'CRMMCP_update_deal_stage' }] } });
        const n = rpc.params?.name;
        if (n === 'CRMMCP_get_customer') return reply({ result: { content: [{ type: 'text', text: '[{"customer_id":"C-1001","name":"Northwind"}]' }] } });
        if (n === 'CRMMCP_update_deal_stage') return reply({ result: { isError: true, content: [{ type: 'text', text: 'Forbidden: update_deal_stage needs the crm:write scope.' }] } });
        if (n === 'GitHubMCP_get_me') return reply({ result: { isError: true, content: [{ type: 'text', text: 'Connection required: visit https://org.example.com/oauth2/v1/sts/redirect?dataHandle=abc' }] } });
        return reply({ error: { code: -32602, message: 'invalid params' } });
      });
    });
    s.listen(0, () => { const url = `http://127.0.0.1:${s.address().port}`; resolve({ url, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }); });
  });
}
const post = (b, path, body) => b(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the real routes attach the right verdict and colour to each kind of outcome', async () => {
  const st = await stub();
  const personas = [{ key: 'sofia', name: 'Sofia Reyes', department: 'Sales', login: 's@x.test', agent: 'Sales Agent', gatewayLabel: 'Sales Tools', gatewayUrl: `${st.url}/mcp/b`, clientId: 'c', clientSecret: 's', callbackPath: '/authorization-code/callback', configured: true,
    blockedTools: [{ name: 'HRMCP_get_compensation', label: 'get_compensation' }] }];
  const app = await startApp({ personas });
  try {
    const b = browser(app.base);
    await post(b, '/api/persona', { key: 'sofia' });
    await post(b, '/api/discover', {});
    const state = new URL((await b('/auth/login')).headers.get('location')).searchParams.get('state');
    await b(`/authorization-code/callback?code=abc&state=${state}`);
    await post(b, '/api/mcp/initialize', {});
    await post(b, '/api/mcp/tools', {});

    await post(b, '/api/mcp/call', { name: 'CRMMCP_get_customer', arguments: { customer_id: 'C-1001' } });
    await post(b, '/api/mcp/call', { name: 'CRMMCP_update_deal_stage', arguments: {} });
    await post(b, '/api/mcp/call', { name: 'GitHubMCP_get_me', arguments: {} });
    await post(b, '/api/mcp/blocked', { tool: 'HRMCP_get_compensation' });

    const events = (await (await b('/api/events/poll?after=0')).json()).events;
    const verdicts = events.filter((e) => e.verdict).map((e) => ({ kind: e.verdict.kind, outcome: e.outcome }));
    assert.deepEqual(verdicts, [
      { kind: 'allowed', outcome: 'ok' },
      { kind: 'blocked-server', outcome: 'denied' },
      { kind: 'consent', outcome: 'denied' },
      { kind: 'blocked-gateway', outcome: 'denied' },
    ]);
    const consent = events.find((e) => e.verdict?.kind === 'consent');
    assert.match(consent.verdict.url, /sts\/redirect\?dataHandle=abc/);
    const blocked = events.find((e) => e.verdict?.kind === 'blocked-gateway');
    assert.match(blocked.verdict.detail, /Get compensation.*Sales Tools/);
    // The allowed call carries the data the page shows in its table.
    const allowed = events.find((e) => e.verdict?.kind === 'allowed');
    assert.match(allowed.response.body.result.content[0].text, /Northwind/);
  } finally { await app.close(); await st.close(); }
});
