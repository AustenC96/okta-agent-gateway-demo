// Dev tool: renders the REAL page (public/) in headless Chrome against a FAKE backend and saves screenshots of each state,
// so the interface can be reviewed without signing in to Okta. Nothing here talks to Okta or AWS.
//   1. npm start                      (any config: only the static files are used)
//   2. node scripts/preview.mjs [outDir] [scenario...]     e.g. node scripts/preview.mjs /tmp/preview allowed blocked
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.PREVIEW_BASE || 'http://localhost:8080';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333, OUT = process.argv[2] || '/tmp/preview';
const WANT = process.argv.slice(3);
const SIZE = { width: Number(process.env.W) || 1600, height: Number(process.env.H) || 1000 };
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the fake backend ----------
const T = (name, description, ro = true) => ({ name, description, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: ro } });
const PERSONAS = [
  { key: 'ethan', chat: true, chips: { ask: ['Who am I on GitHub?', 'Find repositories about Okta'], breakIt: ['Merge pull request 1 on octocat/Hello-World'] }, name: 'Ethan Park', department: 'Engineering', agent: 'Engineering Agent', gatewayLabel: 'Engineering Tools', resourceLabel: 'GitHub', gatewayPath: '/mcp/servers/agent-gateway-agent-gateway', configured: true,
    blockedTools: [{ name: 'GitHubMCP_merge_pull_request', label: 'merge_pull_request (GitHub write)' }, { name: 'GitHubMCP_delete_file', label: 'delete_file (GitHub write)' }, { name: 'CRMMCP_list_deals', label: 'list_deals (Sales CRM)' }, { name: 'HRMCP_get_compensation', label: 'get_compensation (HR)' }],
    tools: [T('GitHubMCP_get_me', 'Get the authenticated user'), T('GitHubMCP_search_repositories', 'Find repositories'), T('GitHubMCP_get_file_contents', 'Read a file')] },
  { key: 'sofia', chat: true, chips: { ask: ['Look up Northwind Logistics', 'Which deals are still open?', 'Show me everything about customer C-1002'], breakIt: ['Show me Hannah Cho’s salary', 'List every employee in the HR directory'] }, name: 'Sofia Reyes', department: 'Sales', agent: 'Sales Agent', gatewayLabel: 'Sales Tools', resourceLabel: 'CRM data', gatewayPath: '/mcp/servers/sales-tools', configured: true,
    blockedTools: [{ name: 'HRMCP_get_compensation', label: 'get_compensation (HR)' }, { name: 'GitHubMCP_get_me', label: 'get_me (GitHub)' }],
    tools: [T('CRMMCP_search_customers', 'Search customers'), T('CRMMCP_get_customer', 'Get one customer'), T('CRMMCP_list_deals', 'List deals'), T('CRMMCP_update_deal_stage', 'Move a deal', false)] },
  { key: 'hannah', chat: true, chips: { ask: ['Who works in Engineering?', 'What is Lena Fischer’s compensation?'], breakIt: ['Move the Northwind deal to Closed Won'] }, name: 'Hannah Cho', department: 'HR', agent: 'HR Agent', gatewayLabel: 'HR Resources', resourceLabel: 'HR data', gatewayPath: '/mcp/servers/hr-resources', configured: true,
    blockedTools: [{ name: 'CRMMCP_update_deal_stage', label: 'update_deal_stage (Sales CRM write)' }, { name: 'GitHubMCP_get_me', label: 'get_me (GitHub)' }],
    tools: [T('HRMCP_list_employees', 'List employees'), T('HRMCP_get_employee', 'Get an employee'), T('HRMCP_get_compensation', 'Get salary')] },
];
const RESULTS = {
  CRMMCP_search_customers: [{ customer_id: 'C-1001', name: 'Northwind Logistics', industry: 'Logistics', tier: 'Enterprise', contact_name: 'Maria Lopez', account_owner: 'Sofia Reyes' }, { customer_id: 'C-1008', name: 'Proseware Financial', industry: 'Financial services', tier: 'Enterprise', contact_name: 'Daniel Osei', account_owner: 'Sofia Reyes' }, { customer_id: 'C-1004', name: 'Tailspin Aerospace', industry: 'Aerospace', tier: 'Enterprise', contact_name: 'Lukas Brandt', account_owner: 'Sofia Reyes' }],
  CRMMCP_get_customer: [{ customer_id: 'C-1001', name: 'Northwind Logistics', industry: 'Logistics', tier: 'Enterprise', contact_name: 'Maria Lopez', contact_email: 'maria.lopez@northwind.example', account_owner: 'Sofia Reyes' }],
  HRMCP_get_compensation: [{ employee_id: 'E-2005', name: 'Hannah Cho', department: 'HR', salary_usd: '98000.00' }],
  GitHubMCP_get_me: { login: 'octocat-demo', name: 'Demo User', public_repos: 8, html_url: 'https://github.com/octocat-demo' },
};
let S, ID;
const reset = (persona = null) => { S = { persona, discovered: false, signedIn: false, connected: false, last: null, events: [], flowBlocked: false, called: false, consent: false }; };
reset();
ID = 0;
const ev = (e) => { const full = { id: ++ID, step: 'mcp', method: 'POST', ms: 120, outcome: 'ok', request: { headers: {}, body: {} }, response: { status: 200, body: {} }, ts: new Date().toISOString(), ...e }; S.events.push(full); return full; };
const me = () => PERSONAS.find((p) => p.key === S.persona);
const GW = (p) => `https://example-org.gateway.oktapreview.com${p.gatewayPath}`;
function flowNodes() {
  const d = (cond) => (cond ? 'done' : 'idle');
  const t = S.called ? 'done' : S.consent ? 'waiting' : 'idle';
  const gw = S.flowBlocked ? 'error' : d(S.connected);
  const past = S.flowBlocked ? 'idle' : null;
  return {
    discover: { status: d(S.discovered), data: { resource: 'x' } }, pkce: { status: d(S.signedIn), data: {} }, code: { status: d(S.signedIn), data: {} },
    access: { status: d(S.signedIn), data: { access_token: 'preview-only-not-a-real-token', claims: { sub: 'user', aud: 'gateway' }, header: { alg: 'RS256' }, expiresAt: Date.now() + 3.6e6 } },
    idtoken: { status: d(S.signedIn), data: { id_token: 'eyJ.x.y', claims: {} } }, gateway: { status: gw, data: { calls: [] } },
    sts: { status: past || (S.called ? 'done' : S.consent ? 'waiting' : 'idle'), data: S.called ? { exchange: { result: 'SUCCESS', at: new Date().toISOString() }, oktaGatewayEvents: [{}] } : null },
    ghtoken: { status: past || d(S.called), data: S.called ? { visible: false } : null }, toolcall: { status: past || t, data: { calls: [] } },
  };
}

// A fake /api/chat: the same events the real agent streams, and the same timeline events the real server records.
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
function fakeChat(prompt) {
  const p = me();
  if (/salary|compensation|HR directory|Closed Won/i.test(prompt) && !/Lena/.test(prompt)) {
    const tool = /Closed Won/.test(prompt) ? 'CRMMCP_update_deal_stage' : /directory/.test(prompt) ? 'HRMCP_list_employees' : 'HRMCP_get_compensation';
    S.flowBlocked = true;
    ev({ node: 'gateway', label: `The agent tried “${tool}”, which the admin did not expose`, url: GW(p), ms: 410, outcome: 'denied', narration: 'The gateway answered MCP error -32602 (“invalid params”): that tool is not exposed to this agent.',
      verdict: { kind: 'blocked-gateway', title: 'Blocked by the gateway', detail: `${tool.replace(/^[A-Za-z0-9]*MCP_/, '').replace(/_/g, ' ')} is not one of the tools ${p.gatewayLabel} exposes.`, tool } });
    return sse([{ type: 'tools', tools: p.tools.map((t) => t.name) }, { type: 'tool_call', id: 't1', name: 'try_other_tool', input: { tool_name: tool, arguments: {} } },
      { type: 'tool_result', id: 't1', status: 'error', text: 'Error: RuntimeError - GATEWAY_REFUSED: Tool execution failed: invalid params' },
      { type: 'text', text: `I tried **${tool}**, but the ${p.gatewayLabel} gateway refused it: that tool is not available to this agent. I can't get that for you; I can help with ${p.resourceLabel} instead.` }, { type: 'done' }]);
  }
  if (S.consent) {
    S.consent = false;
    return sse([{ type: 'tool_call', id: 't1', name: p.tools[0].name, input: { query: 'Northwind' } },
      { type: 'tool_result', id: 't1', status: 'error', text: 'Connection required: visit https://example-org.oktapreview.com/oauth2/v1/sts/redirect?dataHandle=abc to connect your account.' },
      { type: 'text', text: 'I need your one-time approval before I can search the CRM.' }, { type: 'done' }]);
  }
  S.called = true; S.connected = true;
  ev({ node: 'toolcall', label: `The agent called “${p.tools[0].name}”`, url: GW(p), ms: 1840, narration: 'Claude chose the tool from the tools the gateway listed. The agent forwarded Sofia’s own token to the gateway.', verdict: { kind: 'allowed', title: 'Allowed', detail: 'Search customers ran through the gateway.', tool: p.tools[0].name } });
  return sse([{ type: 'tools', tools: p.tools.map((t) => t.name) }, { type: 'tool_call', id: 't1', name: p.tools[0].name, input: { query: 'Northwind' } },
    { type: 'tool_result', id: 't1', status: 'success', text: '[{"customer_id":"C-1001","name":"Northwind Logistics","tier":"Enterprise"}]' },
    { type: 'text', text: 'Found one match:\n\n| ID | Customer | Tier | Owner |\n|---|---|---|---|\n| C-1001 | Northwind Logistics | Enterprise | Sofia Reyes |\n\nWant me to pull up its open deals?' }, { type: 'done' }]);
}
function route(method, path, body) {
  const p = me();
  if (path === '/api/transport') return { mode: 'poll' };
  if (path === '/api/page-load') return { returned: true };
  if (path === '/api/config') return { gatewayUrl: p ? GW(p) : GW(PERSONAS[0]), personas: PERSONAS.map(({ tools, ...x }) => x), persona: S.persona, discovered: S.discovered, signedIn: S.signedIn,
    tokenInfo: S.signedIn ? { claims: { sub: p.name.toLowerCase().replace(' ', '.') + '@agentgateway.demo' }, expiresAt: Date.now() + 3.6e6 } : null };
  if (path === '/api/persona') { reset(body.key); return { ok: true, persona: body.key }; }
  if (path === '/api/events/clear') { S.events = []; return { ok: true }; }
  if (path.startsWith('/api/events/poll')) { const after = Number(new URL('http://x' + path).searchParams.get('after') || 0); const init = path.includes('init=1'); return init ? { head: ID } : { events: S.events.filter((e) => e.id > after), head: ID }; }
  if (path === '/api/flow') return { nodes: flowNodes() };
  if (path === '/api/discover') {
    S.discovered = true;
    ev({ step: 'discover', node: 'discover', label: 'Knock on the gateway with no credentials', url: GW(p), response: { status: 401 }, outcome: 'ok', ms: 301, narration: 'The gateway answered 401 Unauthorized, which is what we want to see. It will not talk to anonymous callers. Its WWW-Authenticate header tells the client where to find its OAuth metadata. This is how any MCP client discovers how to sign in.' });
    ev({ step: 'discover', node: 'discover', method: 'GET', label: 'Read the gateway’s protected-resource metadata', url: GW(p) + '/meta', ms: 211, narration: `The gateway says it is the protected resource “${p.gatewayPath}” and that tokens must come from its own Okta authorization server. The client now knows exactly who to ask for a token.` });
    return { ok: true };
  }
  if (path === '/api/mcp/initialize') { S.connected = true; ev({ label: 'Open an MCP session through the gateway', url: GW(p), ms: 644, node: 'gateway', narration: `The gateway accepted our Okta token and answered as MCP server “${p.gatewayPath.split('/').pop()}”. It advertises capabilities: tools.` }); return { result: {} }; }
  if (path === '/api/mcp/tools') { ev({ label: 'Ask the gateway which tools this agent may use', url: GW(p), ms: 160, node: 'gateway', narration: `The gateway returned ${p.tools.length} tools. These are the tools the admin chose to expose from the upstream server, not everything the service offers.` }); return { result: { tools: p.tools }, consentUrl: null }; }
  if (path === '/api/mcp/call') {
    if (S.consent) {
      ev({ label: `Call tool “${body.name}”`, url: GW(p), ms: 1918, node: 'toolcall', narration: 'The gateway could not call the downstream service yet: Okta needs this user to consent once, and returned a link.', verdict: { kind: 'consent', title: 'One-time consent needed', detail: 'Okta must ask this user to approve access to the service once.', url: 'https://example-org.oktapreview.com/oauth2/v1/sts/redirect?dataHandle=x' } });
      return { consentUrl: 'https://x' };
    }
    S.called = true; const r = RESULTS[body.name] ?? { ok: true };
    ev({ label: `Call tool “${body.name}”`, url: GW(p), ms: 1342, node: 'toolcall', narration: 'The gateway forwarded the call to the downstream service using a token the agent never saw, and relayed the result. 1342 ms round trip including the token exchange.', response: { status: 200, body: { result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } } }, verdict: { kind: 'allowed', title: 'Allowed', detail: `${body.name.replace(/^.*MCP_/, '').replace(/_/g, ' ')} ran through the gateway.` } });
    setTimeout(() => ev({ step: 'mcp', node: 'sts', method: 'GET', label: 'Okta System Log: the token exchange behind that call', url: 'https://example-org.oktapreview.com/api/v1/logs', ms: 10859, narration: 'Okta’s System Log confirms the exchange (SUCCESS). The gateway, signing in as its own workload identity, presented the agent’s access token. Okta checked the delegation link and resource connection, then returned a downstream token in 212 ms.', evidence: 'Okta’s log: token exchange SUCCESS in 212 ms' }), 1500);
    return { result: { content: [{ type: 'text', text: JSON.stringify(r) }] } };
  }
  if (path === '/api/mcp/blocked') {
    S.flowBlocked = true;
    ev({ label: `Call “${body.tool}”, which the admin did not expose`, url: GW(p), ms: 457, node: 'gateway', outcome: 'denied', narration: `The gateway did not run it. It answered with MCP error -32602 (“invalid params”). ${body.tool} is not among the ${p.tools.length} tools the gateway listed for this agent. The next card shows what Okta’s own log recorded, including why.`, verdict: { kind: 'blocked-gateway', title: 'Blocked by the gateway', detail: `${body.tool.replace(/^.*MCP_/, '').replace(/_/g, ' ')} is not one of the tools ${p.gatewayLabel} exposes.` } });
    setTimeout(() => ev({ node: 'gateway', method: 'GET', label: 'Okta System Log: what Okta recorded for the blocked call', url: 'https://example-org.oktapreview.com/api/v1/logs', ms: 15210, narration: `Okta’s own log recorded the gateway’s tool.call event with result DENY, reason: tool "${body.tool}" not found. It shows no token exchange for you in that window, so the gateway stopped the call before any downstream token was requested.`, evidence: `Okta’s log: DENY (tool "${body.tool}" not found); no token exchange` }), 1500);
    return { error: { code: -32602, message: 'invalid params' } };
  }
  return { error: 'not faked: ' + path };
}

// ---------- Chrome over the DevTools protocol ----------
async function launch() {
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/preview-profile-${Date.now()}`, '--allow-insecure-localhost', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); const pg = l.find((t) => t.type === 'page'); if (pg) return { proc, ws: pg.webSocketDebuggerUrl }; } catch { /* not up yet */ } await sleep(250); }
  throw new Error('Chrome did not start');
}
const { proc, ws: wsUrl } = await launch();
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = async (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); return; }
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params; const u = new URL(request.url);
    if (!u.pathname.startsWith('/api/')) return send('Fetch.continueRequest', { requestId });
    let body = {}; try { body = JSON.parse(request.postData || '{}'); } catch { /* none */ }
    if (u.pathname === '/api/chat') return send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }], body: Buffer.from(fakeChat(body.prompt || '')).toString('base64') });
    const out = route(request.method, u.pathname + u.search, body);
    return send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'cache-control', value: 'no-store' }], body: Buffer.from(JSON.stringify(out)).toString('base64') });
  }
};
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
if (!process.env.REAL) await send('Fetch.enable', { patterns: [{ urlPattern: `${BASE}/*` }] }); // REAL=1 talks to the real server instead of the fake
await send('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: 1, mobile: false });
const ev$ = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const click = (sel, i = 0) => ev$(`(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${i}];if(!e)throw new Error('no element '+${JSON.stringify(sel)});e.click();return true})()`);
const shot = async (name) => { await sleep(900); const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64')); console.log('saved', `${OUT}/${name}.png`); };
const open = async () => { await send('Page.navigate', { url: BASE + '/' }); await sleep(1200); };
const choose = async (key) => { await click(`.personaCard[data-key="${key}"]`); await sleep(700); };
const signIn = async () => { S.signedIn = true; await ev$('load()'); await sleep(500); };

const ERRORS = [];
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') ERRORS.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] || d.params.exceptionDetails.text); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') ERRORS.push(d.params.args.map((x) => x.value || x.description).join(' ')); });
const SCENARIOS = {
  async picker() { reset(); await open(); await shot('01-picker'); },
  // Also clicks the button: the page must call discovery and then head for /auth/login (the fake backend answers discovery; Chrome then leaves for the real path).
  async start() { reset(); await open(); await choose('sofia'); await shot('02-sign-in'); await click('#go'); await sleep(1200); console.log('after Sign in, the page is at:', await ev$('location.pathname')); },
  async chat() { reset(); await open(); await choose('sofia'); await signIn(); await shot('03-chat-empty'); },
  async allowed() { await SCENARIOS.chat(); await click('.chip[data-p]', 0); await sleep(1500); await shot('04-chat-allowed'); },
  async blocked() { await SCENARIOS.chat(); await click('.chip.warn[data-p]', 0); await sleep(1500); await shot('05-chat-blocked'); },
  async consent() { await SCENARIOS.chat(); S.consent = true; await click('.chip[data-p]', 0); await sleep(1500); await shot('06-chat-consent'); },
  async okta() { await SCENARIOS.chat(); ev({ step: 'login', label: 'Okta refused Sofia Reyes access to the HR Agent', method: 'GET', url: 'https://example-org.oktapreview.com/authorization-code/callback', ms: 0, outcome: 'denied', narration: 'Okta refused the sign-in: Sofia is not assigned to the HR Agent.', verdict: { kind: 'blocked-okta', title: 'Blocked by Okta', detail: 'Sofia Reyes is not assigned to the HR Agent.', target: { agent: 'HR Agent', gateway: 'HR Resources', resource: 'HR data' } } }); await sleep(2500); await shot('07-okta'); await click('#backBtn'); await sleep(500); await shot('07b-back-to-chat'); },
  async hood() { await SCENARIOS.allowed(); await click('#hood'); await sleep(800); await shot('08-under-the-hood'); },
  // REAL=1 only: drives the real server as far as it can go without a password (picker, choose) and reports what the page shows.
  async real() { await open(); await choose('sofia'); await sleep(1500); console.log('sign-in card:', await ev$("document.querySelector('#go')?.textContent"), '| steps:', await ev$("[...document.querySelectorAll('#steps li b')].map((b) => b.textContent).join(' > ')")); await shot('real-sign-in'); },
};
try {
  for (const name of (WANT.length ? WANT : Object.keys(SCENARIOS).filter((n) => n !== 'real'))) { console.log('scenario', name); await SCENARIOS[name](); }
} finally { ws.close(); proc.kill(); }
if (ERRORS.length) { console.error('PAGE ERRORS (the page threw while being driven):\n  ' + [...new Set(ERRORS)].join('\n  ')); process.exitCode = 1; }
