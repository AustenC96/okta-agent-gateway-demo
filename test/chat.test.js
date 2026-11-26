import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, browser } from './helpers.js';

// The chat sends the signed-in person's own Okta token to their team's agent (Amazon Bedrock AgentCore) and turns the agent's tool events into the
// same verdicts the page shows everywhere else. Here the gateway/Okta and AgentCore are both stand-ins; nothing real is touched.
const jwt = (c) => ['{"alg":"none"}', JSON.stringify(c), 'x'].map((p, i) => (i === 2 ? p : Buffer.from(p).toString('base64url'))).join('.');
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
});
const oktaStub = () => listen((rq, res) => {
  const base = `http://127.0.0.1:${rq.socket.localPort}`;
  res.setHeader('content-type', 'application/json');
  if (rq.url === '/token') return res.end(JSON.stringify({ access_token: jwt({ sub: 'sofia', aud: 'x' }), token_type: 'Bearer', expires_in: 3600 }));
  if (rq.url.startsWith('/.well-known/oauth-protected-resource')) return res.end(JSON.stringify({ resource: `${base}/mcp/b`, authorization_servers: [base], scopes_supported: ['openid'] }));
  if (rq.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] }));
  if (!rq.headers.authorization) { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/b"`); }
  res.end('{}');
});
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
// A stand-in for AgentCore: records what it was sent and streams back whatever script the test chose.
const agentStub = (script, status = 200) => {
  const seen = [];
  return listen((rq, res) => {
    let body = ''; rq.on('data', (c) => (body += c)); rq.on('end', () => {
      seen.push({ url: rq.url, headers: rq.headers, body: JSON.parse(body || '{}') });
      res.statusCode = status; res.setHeader('content-type', status === 200 ? 'text/event-stream' : 'application/json');
      res.end(status === 200 ? sse(script) : '{"message":"denied"}');
    });
  }).then((s) => ({ ...s, seen }));
};
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agw_demo_sales-abc';
async function signedIn(okta, agent, extra = {}) {
  const personas = [{ key: 'sofia', name: 'Sofia Reyes', department: 'Sales', login: 's@x.test', agent: 'Sales Agent', gatewayLabel: 'Sales Tools', gatewayUrl: `${okta.url}/mcp/b`, clientId: 'c', clientSecret: 's',
    callbackPath: '/authorization-code/callback', blockedTools: [], configured: true, agentArn: ARN, agentEndpoint: agent?.url, ...extra }];
  const app = await startApp({ personas });
  const b = browser(app.base);
  const post = (p, body) => b(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('/api/persona', { key: 'sofia' }); await post('/api/discover', {});
  const state = new URL((await b('/auth/login')).headers.get('location')).searchParams.get('state');
  await b(`/authorization-code/callback?code=abc&state=${state}`);
  return { app, b, post };
}
const verdicts = async (b) => (await (await b('/api/events/poll?after=0')).json()).events.filter((e) => e.verdict);

test('the person’s own token goes to their team’s agent, and an allowed tool call becomes an Allowed verdict', async () => {
  const okta = await oktaStub();
  const agent = await agentStub([{ type: 'tools', tools: ['CRMMCP_search_customers'] }, { type: 'tool_call', id: 't1', name: 'CRMMCP_search_customers', input: { query: 'Northwind' } },
    { type: 'tool_result', id: 't1', status: 'success', text: '[{"name":"Northwind"}]' }, { type: 'text', text: 'Found it.' }, { type: 'done' }]);
  const { app, b, post } = await signedIn(okta, agent);
  try {
    const r = await post('/api/chat', { prompt: 'Look up Northwind' });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /"type":"text","text":"Found it\."/, 'the stream is passed through to the page');
    const sent = agent.seen[0];
    assert.match(sent.headers.authorization, /^Bearer /, 'the access token is forwarded');
    assert.ok(sent.headers['x-amzn-bedrock-agentcore-runtime-session-id'].length >= 33, 'AgentCore needs a session id of 33+ characters');
    assert.deepEqual(sent.body, { prompt: 'Look up Northwind' });
    assert.ok(sent.url.includes(encodeURIComponent(ARN)), 'the runtime ARN is URL-encoded in the path');
    const v = await verdicts(b);
    assert.deepEqual(v.map((e) => e.verdict.kind), ['allowed']);
    assert.match(v[0].label, /CRMMCP_search_customers/);
  } finally { await app.close(); await okta.close(); await agent.close(); }
});

test('an attempt at another team’s tool that the gateway refuses is Blocked by the gateway', async () => {
  const okta = await oktaStub();
  const agent = await agentStub([{ type: 'tool_call', id: 't1', name: 'try_other_tool', input: { tool_name: 'HRMCP_get_compensation', arguments: {} } },
    { type: 'tool_result', id: 't1', status: 'error', text: 'Error: RuntimeError - GATEWAY_REFUSED: Tool execution failed: invalid params' }, { type: 'text', text: 'Refused.' }, { type: 'done' }]);
  const { app, b, post } = await signedIn(okta, agent);
  try {
    await (await post('/api/chat', { prompt: 'Show me Hannah’s salary' })).text();
    const v = await verdicts(b);
    assert.deepEqual(v.map((e) => e.verdict.kind), ['blocked-gateway']);
    assert.match(v[0].verdict.detail, /Get compensation.*Sales Tools/);
    assert.equal(v[0].outcome, 'denied');
    assert.match(v[0].label, /HRMCP_get_compensation/);
  } finally { await app.close(); await okta.close(); await agent.close(); }
});

test('the fallback tool succeeding is flagged as Not blocked, never shown as Allowed', async () => {
  const okta = await oktaStub();
  const agent = await agentStub([{ type: 'tool_call', id: 't1', name: 'try_other_tool', input: { tool_name: 'HRMCP_get_compensation' } },
    { type: 'tool_result', id: 't1', status: 'success', text: '[{"salary":1}]' }, { type: 'done' }]);
  const { app, b, post } = await signedIn(okta, agent);
  try {
    await (await post('/api/chat', { prompt: 'x' })).text();
    assert.deepEqual((await verdicts(b)).map((e) => e.verdict.kind), ['problem']);
  } finally { await app.close(); await okta.close(); await agent.close(); }
});

test('a consent request relayed by the gateway becomes a consent verdict with its link', async () => {
  const okta = await oktaStub();
  const agent = await agentStub([{ type: 'tool_call', id: 't1', name: 'CRMMCP_search_customers', input: {} },
    { type: 'tool_result', id: 't1', status: 'error', text: 'Connection required: visit https://org.example.com/oauth2/v1/sts/redirect?dataHandle=abc to connect your account.' }, { type: 'done' }]);
  const { app, b, post } = await signedIn(okta, agent);
  try {
    await (await post('/api/chat', { prompt: 'x' })).text();
    const v = await verdicts(b);
    assert.equal(v[0].verdict.kind, 'consent');
    assert.match(v[0].verdict.url, /sts\/redirect\?dataHandle=abc/);
  } finally { await app.close(); await okta.close(); await agent.close(); }
});

test('AgentCore refusing the token is reported as a sign-in problem, not a crash', async () => {
  const okta = await oktaStub();
  const agent = await agentStub([], 403);
  const { app, post } = await signedIn(okta, agent);
  try {
    const r = await post('/api/chat', { prompt: 'x' });
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /refused the token/);
  } finally { await app.close(); await okta.close(); await agent.close(); }
});

test('chat refuses when not signed in, when there is no agent, or when the message is empty', async () => {
  const okta = await oktaStub();
  const agent = await agentStub([{ type: 'done' }]);
  try {
    const anon = await startApp({ personas: [{ key: 'sofia', name: 'S', department: 'Sales', login: 's@x.test', agent: 'A', gatewayLabel: 'G', gatewayUrl: `${okta.url}/mcp/b`, clientId: 'c', clientSecret: 's', callbackPath: '/authorization-code/callback', blockedTools: [], configured: true, agentArn: ARN, agentEndpoint: agent.url }] });
    const ab = browser(anon.base);
    await ab('/api/persona', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sofia' }) });
    assert.equal((await ab('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"x"}' })).status, 401);
    await anon.close();
    const noAgent = await signedIn(okta, agent, { agentArn: undefined });
    assert.equal((await noAgent.post('/api/chat', { prompt: 'x' })).status, 400);
    await noAgent.app.close();
    const empty = await signedIn(okta, agent);
    assert.equal((await empty.post('/api/chat', { prompt: '   ' })).status, 400);
    await empty.app.close();
    assert.equal(agent.seen.length, 0, 'nothing reaches the agent in any of these cases');
  } finally { await okta.close(); await agent.close(); }
});
