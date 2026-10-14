const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { cfg: null, discovered: false, tools: null, busy: false, consentUrl: null };
let eventCount = 0;
// Declared up here because renderEvent() runs during the post-Okta trace replay, before the rest of the file has executed.
const flow = { nodes: null, sig: {}, selected: null, pinned: false, lastNode: null, timer: null };

async function api(path, body) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

// ---------- live trace ----------
// Sign-in leaves the page for Okta, so the trace is carried across that one redirect via sessionStorage.
// Any other load (first visit, manual refresh) starts with an empty trace.
const carried = JSON.parse(sessionStorage.getItem('carriedTrace') || 'null');
sessionStorage.removeItem('carriedTrace');
const seen = [];
let lastId = 0;
const es = new EventSource(carried ? `/api/events?after=${carried.lastId}` : '/api/events');
es.onmessage = (m) => renderEvent(JSON.parse(m.data), false);
document.addEventListener('click', (e) => {
  if (e.target.closest('a[href="/auth/login"]')) sessionStorage.setItem('carriedTrace', JSON.stringify({ events: seen, lastId }));
});
function renderEvent(ev, instant) {
  seen.push(ev); lastId = Math.max(lastId, ev.id || 0);
  const num = seen.length;
  const feed = $('#feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  feed.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'slot';
  const st = ev.response?.status ?? (ev.error ? 'ERR' : '↗');
  const u = new URL(ev.url, location.href);
  el.innerHTML = `<div class="slotInner"><div class="ev ${ev.outcome}">
    <header>
      <span class="num">${num}</span>
      <span class="badge">${esc(ev.method.split(' ')[0])}</span>
      <span class="title">${esc(ev.label)}</span>
      <span class="status">${esc(st)}</span>
      <span class="ms">${ev.ms}ms</span>
    </header>
    <div class="url">${esc(u.host + u.pathname)}</div>
    <div class="story">${esc(ev.narration)}</div>
    <div class="raw">
      <h4>Request</h4><pre>${esc(JSON.stringify(ev.request, null, 2))}</pre>
      <h4>Response</h4><pre>${esc(JSON.stringify(ev.response, null, 2))}</pre>
    </div></div></div>`;
  const card = el.querySelector('.ev');
  card.querySelector('header').onclick = () => card.classList.toggle('open');
  // Append at the bottom (oldest first). The card grows open, and if the reader was already
  // at the bottom the feed follows it down for the length of the animation.
  feed.append(el);
  if (instant) el.classList.add('in', 'instant');
  else requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  if (stick) {
    const end = performance.now() + (instant ? 0 : 700);
    (function follow() { feed.scrollTop = feed.scrollHeight; if (performance.now() < end) requestAnimationFrame(follow); })();
  }
  if (ev.node) { flow.lastNode = ev.node; clearTimeout(flow.timer); flow.timer = setTimeout(refreshFlow, 120); }
  $('#count').textContent = `${++eventCount} call${eventCount === 1 ? '' : 's'}`;
  render();
}
$('#clearBtn').onclick = async () => { await api('/api/events/clear', {}); seen.length = 0; $('#feed').innerHTML = '<div class="empty">Cleared. New calls will appear here.</div>'; eventCount = 0; $('#count').textContent = '0 calls'; };

// ---------- stage ----------
function currentStep() {
  if (!state.discovered) return 'discover';
  if (!state.cfg?.signedIn) return 'login';
  if (!state.tools) return 'session';
  return 'tools';
}
function render() {
  const cur = currentStep();
  const order = ['discover', 'login', 'session', 'tools'];
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step), c = order.indexOf(cur);
    li.className = i < c ? 'done' : i === c ? 'active' : '';
  });
  const body = $('#stageBody');
  const busy = state.busy ? 'disabled' : '';
  const consent = state.consentUrl ? `<div class="consent">Okta needs a one-time consent before the gateway can use GitHub on your behalf. <a href="${esc(state.consentUrl)}" target="_blank" rel="noopener">Authorize GitHub →</a> then retry.</div>` : '';
  if (cur === 'discover') {
    body.innerHTML = `<h2>An agent meets the gateway</h2><p>The agent knows only one URL. It has no credentials. Watch how it learns what to do next.</p><button id="go" ${busy}>Discover the gateway</button>`;
    $('#go').onclick = () => run(async () => { await api('/api/discover', {}); });
  } else if (cur === 'login') {
    body.innerHTML = `<h2>Authenticate the user</h2><p>The gateway told us which Okta authorization server to use. Sign in so the agent can act on <i>your</i> behalf, not as a shared service account.</p><a class="btn" href="/auth/login">Sign in with Okta</a>`;
  } else if (cur === 'session') {
    body.innerHTML = `<h2>Open a session through the gateway</h2><p>Present the token, then ask what tools this agent is allowed to use. The gateway does the heavy lifting upstream.</p><button id="go" ${busy}>Connect & list tools</button>${consent}`;
    $('#go').onclick = () => run(async () => {
      state.consentUrl = null;
      const init = await api('/api/mcp/initialize', {});
      if (init.error) return;
      const t = await api('/api/mcp/tools', {});
      state.consentUrl = t.consentUrl || null;
      if (t.result?.tools) state.tools = t.result.tools;
    });
  } else {
    const list = state.tools.length ? state.tools.map((t, i) => `
      <div class="tool"><div><code>${esc(t.name)}</code><small>${esc((t.description || '').slice(0, 140))}</small></div>
      ${isReadOnly(t) ? `<button data-i="${i}" ${busy} title="Sample input: ${esc(JSON.stringify(sampleArgs(t)))}">Run</button>` : `<button disabled title="This tool changes data on GitHub, so the demo does not run it">Writes</button>`}</div>`).join('') : '<p>The gateway returned no tools. Ask the admin to expose some on the virtual MCP server.</p>';
    body.innerHTML = `<h2>${state.tools.length} tools available</h2><p>Only what the admin exposed on the virtual MCP server. Run one with a built-in sample input and watch the token flow. Read-only tools only.</p><div class="toolsHint">Scroll to see all ${state.tools.length}</div><div class="tools">${list}</div>${consent}`;
    body.querySelectorAll('.tool button[data-i]').forEach((b) => b.onclick = () => callTool(state.tools[b.dataset.i]));
  }
  renderFlow();
}
// ---------- sample inputs (the demo never asks the user for arguments) ----------
const SAMPLE_OWNER = 'octocat', SAMPLE_REPO = 'Hello-World';
const SAMPLE_BY_TOOL = {
  search_repositories: { query: `repo:${SAMPLE_OWNER}/${SAMPLE_REPO}` },
  search_code: { query: `repo:${SAMPLE_OWNER}/${SAMPLE_REPO} hello` },
  search_issues: { query: `repo:${SAMPLE_OWNER}/${SAMPLE_REPO} is:issue` },
  search_pull_requests: { query: `repo:${SAMPLE_OWNER}/${SAMPLE_REPO} is:pr` },
  search_users: { query: SAMPLE_OWNER },
  search_orgs: { query: 'github' },
  get_file_contents: { owner: SAMPLE_OWNER, repo: SAMPLE_REPO, path: 'README' },
};
const BY_PROP = { owner: SAMPLE_OWNER, repo: SAMPLE_REPO, repository: SAMPLE_REPO, username: SAMPLE_OWNER, user: SAMPLE_OWNER, org: 'github', organization: 'github',
  query: SAMPLE_OWNER, q: SAMPLE_OWNER, path: 'README', ref: 'master', branch: 'master', sha: 'master', page: 1 };
// Read-only unless the server says otherwise; a missing annotation falls back to the verb in the name.
// The gateway publishes tools under an alias such as GitHubMCP_get_me; match on the underlying GitHub tool name.
const baseName = (t) => t.name.replace(/^[A-Za-z0-9]*MCP_/, '');
const isReadOnly = (t) => (t.annotations?.readOnlyHint === true) || (t.annotations?.readOnlyHint == null && /^(get|list|search)_/.test(baseName(t)));
function sampleArgs(tool) {
  const schema = tool.inputSchema || {}, props = schema.properties || {}, args = { ...(SAMPLE_BY_TOOL[baseName(tool)] || {}) };
  for (const k of schema.required || []) {
    if (k in args) continue;
    const p = props[k] || {};
    if (k in BY_PROP) args[k] = BY_PROP[k];
    else if (/(number|_id$|^id$)/i.test(k) && ['number', 'integer'].includes(p.type)) args[k] = 1;
    else if (p.enum?.length) args[k] = p.enum[0];
    else if (p.type === 'boolean') args[k] = false;
    else if (p.type === 'number' || p.type === 'integer') args[k] = p.minimum ?? 1;
    else if (p.type === 'array') args[k] = [];
    else if (p.type === 'object') args[k] = {};
    else args[k] = SAMPLE_OWNER;
  }
  for (const k of ['perPage', 'per_page']) if (k in props && !(k in args)) args[k] = 3; // keep the answer short
  return args;
}
async function callTool(tool) {
  const args = sampleArgs(tool);
  run(async () => {
    state.consentUrl = null;
    const r = await api('/api/mcp/call', { name: tool.name, arguments: args });
    state.consentUrl = r.consentUrl || null;
    $('#resultCard').hidden = false;
    $('#resultMeta').textContent = `${tool.name}(${JSON.stringify(args)})`;
    const text = r.result ? (r.result.content || []).map((c) => c.text ?? JSON.stringify(c)).join('\n') : JSON.stringify(r, null, 2);
    $('#resultBody').textContent = text.length > 6000 ? text.slice(0, 6000) + `\n… (${text.length - 6000} more characters)` : text;
  });
}
async function run(fn) { state.busy = true; render(); try { await fn(); } finally { state.busy = false; await load(); } }
async function load() {
  state.cfg = await api('/api/config');
  state.discovered = state.cfg.discovered;
  $('#gwHost').textContent = new URL(state.cfg.gatewayUrl).host;
  const t = state.cfg.tokenInfo;
  $('#who').innerHTML = t ? `<span class="pill ok">${esc(t.claims?.sub || 'signed in')}</span><button class="ghost" id="out">Sign out</button>` : '<span class="pill">signed out</span>';
  // Sign out wipes the server session, then reloads so the page is exactly as on first load.
  if (t) $('#out').onclick = async () => { await api('/api/logout', {}); sessionStorage.removeItem('carriedTrace'); location.reload(); };
  render();
  refreshFlow();
}
// The server knows whether this load is the return from Okta (keep progress) or a plain load (start at step 1).
api('/api/page-load', {}).then(load);

// ---------- token flow DAG ----------
const W = 150, H = 52;
const NODE_META = {
  discover: { x: 10,  y: 10,  t: 'Discover',          s: 'who issues tokens?', about: 'The agent knows one URL and has no credentials. An unauthenticated call gets a 401 whose WWW-Authenticate header points to the gateway’s metadata, which names the Okta authorization server that must issue the token. No token exists yet; this stage is how the client learns where to get one.' },
  pkce:     { x: 205, y: 10,  t: 'PKCE secret',       s: 'verifier + challenge', about: 'Before leaving for Okta the app invents a random secret (the verifier) and sends only its SHA-256 hash (the challenge). Whoever steals the redirect later cannot redeem the code without the verifier, which never left this server. The resource parameter pins the coming token to this gateway.' },
  code:     { x: 400, y: 10,  t: 'Authorization code', s: 'one-time, from Okta', about: 'The user signed in at Okta and the browser was redirected back with a short-lived, single-use code. It is not a credential for anything on its own.' },
  access:   { x: 400, y: 110, t: 'Access token',      s: 'minted by Okta', about: 'The app redeemed the code plus the PKCE verifier at the gateway’s custom authorization server. This JWT is the only credential the agent ever holds. Its audience is the gateway, so it is useless anywhere else.' },
  idtoken:  { x: 205, y: 110, t: 'ID token',          s: 'who signed in', about: 'Issued alongside the access token because the openid scope was requested. It tells the app who the user is. It is not sent to the gateway.' },
  gateway:  { x: 400, y: 210, t: 'Gateway',           s: 'validates the token', about: 'Each MCP call carries the access token as a Bearer credential. The gateway checks its signature and audience against the linked authorization server and that the virtual MCP server is active.' },
  sts:      { x: 205, y: 210, t: 'Okta token exchange', s: 'STS, inside Okta', about: 'When a tool is called, the gateway presents the agent’s access token to Okta’s security token service. Okta checks the delegation link (is this agent allowed to use this virtual MCP server?) and the resource connection to GitHub, then returns a GitHub token. If Okta doesn’t yet hold a GitHub grant for the user, the user is asked to consent once; after that, Okta reuses what it stored, so there is no prompt.' },
  ghtoken:  { x: 10,  y: 210, t: 'GitHub token',      s: 'never reaches the agent', about: 'The downstream credential the gateway injects into the outbound call to GitHub. It is held by Okta and the gateway, never by the agent or this app, which is the point: a prompt-injected or compromised agent has nothing to leak. Because it is invisible by design, this stage shows Okta’s record that it was issued, not the token.' },
  toolcall: { x: 10,  y: 310, t: 'Tool call',         s: 'GitHub via gateway', about: 'The gateway forwards the tool call to GitHub with the downstream token and relays the answer. The calls below are what this app sent and what came back.' },
};
const EDGES = [['discover','pkce','r','l'],['pkce','code','r','l'],['code','access','b','t'],['code','idtoken','b','t'],['access','gateway','b','t'],['gateway','sts','l','r'],['sts','ghtoken','l','r'],['ghtoken','toolcall','b','t']];
const STATUS_LABEL = { done: 'Observed', error: 'Failed', waiting: 'Needs you', inferred: 'Inferred', idle: 'Not reached yet', skipped: 'Not issued' };
const DIR = { r: [1, 0], l: [-1, 0], b: [0, 1], t: [0, -1] };
const NS = 'http://www.w3.org/2000/svg';
const port = (n, side) => ({ r: [n.x + W, n.y + H / 2], l: [n.x, n.y + H / 2], b: [n.x + W / 2, n.y + H], t: [n.x + W / 2, n.y] }[side]);

function buildDag() {
  const svg = $('#dag');
  svg.innerHTML = `<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#4a5270"/></marker></defs>`;
  EDGES.forEach(([a, b, sa, sb], i) => {
    const [x1, y1] = port(NODE_META[a], sa), [x2, y2] = port(NODE_META[b], sb), da = DIR[sa], db = DIR[sb], k = 42;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', `M${x1} ${y1} C${x1 + da[0] * k} ${y1 + da[1] * k} ${x2 + db[0] * k} ${y2 + db[1] * k} ${x2 - db[0] * 4} ${y2 - db[1] * 4}`);
    p.setAttribute('class', 'edge'); p.setAttribute('marker-end', 'url(#arr)'); p.dataset.e = i;
    svg.appendChild(p);
  });
  for (const [id, m] of Object.entries(NODE_META)) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'node idle'); g.dataset.id = id;
    g.innerHTML = `<rect x="${m.x}" y="${m.y}" width="${W}" height="${H}" rx="11"/><circle class="dot" cx="${m.x + 14}" cy="${m.y + 16}" r="4"/>
      <text class="t" x="${m.x + 26}" y="${m.y + 20}">${esc(m.t)}</text><text class="s" x="${m.x + 14}" y="${m.y + 39}">${esc(m.s)}</text>`;
    svg.appendChild(g);
  }
}
async function refreshFlow() {
  const r = await api('/api/flow');
  if (!r.nodes) return;
  flow.nodes = r.nodes;
  renderFlow(true);
}
function renderFlow(fresh) {
  if (!$('#dag').firstChild) buildDag();
  const nodes = flow.nodes || {};
  if (fresh) {
    for (const [id, n] of Object.entries(nodes)) {
      const sig = JSON.stringify([n.status, n.data]);
      if (flow.sig[id] !== undefined && flow.sig[id] !== sig) {
        const g = $(`#dag .node[data-id="${id}"]`); g.classList.remove('pulse'); void g.getBoundingClientRect(); g.classList.add('pulse');
      }
      flow.sig[id] = sig;
    }
    if (!flow.pinned) {
      const pick = flow.lastNode && nodes[flow.lastNode] && nodes[flow.lastNode].status !== 'idle' ? flow.lastNode : null;
      if (pick) flow.selected = pick;
    }
  }
  document.querySelectorAll('#dag .node').forEach((g) => {
    const n = nodes[g.dataset.id], st = n?.status || 'idle';
    g.setAttribute('class', `node ${st}${g.dataset.id === flow.selected ? ' sel' : ''}${g.classList.contains('pulse') ? ' pulse' : ''}`);
  });
  document.querySelectorAll('#dag .edge').forEach((p) => {
    const [a, b] = EDGES[p.dataset.e], on = (id) => nodes[id] && nodes[id].status !== 'idle' && nodes[id].status !== 'skipped';
    p.setAttribute('class', `edge${on(a) && on(b) ? ' lit' : ''}`);
  });
  $('#followBtn').textContent = flow.pinned ? 'Follow live' : 'Following live';
  $('#followBtn').classList.toggle('pinned', flow.pinned);
  renderDetail();
}
$('#dag').addEventListener('click', (e) => {
  const g = e.target.closest('.node'); if (!g) return;
  flow.selected = g.dataset.id; flow.pinned = true; renderFlow();
});
$('#followBtn').onclick = () => { flow.pinned = false; if (flow.lastNode && flow.nodes?.[flow.lastNode]?.status !== 'idle') flow.selected = flow.lastNode; renderFlow(); };
document.addEventListener('click', (e) => {
  const b = e.target.closest('button.copy'); if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200);
});

const TOKEN_KEYS = { access_token: 'access_token (JWT)', id_token: 'id_token (JWT)', authorization_code: 'authorization_code', code_verifier: 'code_verifier', code_challenge: 'code_challenge = SHA-256(verifier)' };
const tokBox = (label, v) => `<div class="tok"><div class="tokHead"><span>${esc(label)}</span><button class="ghost copy" data-copy="${esc(v)}">Copy</button></div><pre>${esc(v)}</pre></div>`;
const when = (ms) => new Date(ms).toLocaleTimeString();
function renderDetail() {
  const el = $('#flowDetail'), id = flow.selected, m = NODE_META[id], n = flow.nodes?.[id];
  const keep = el.scrollTop;
  if (!m) { el.innerHTML = '<div class="empty">Click any stage to see the actual tokens and calls at that point. The diagram fills in live as the flow runs.</div>'; return; }
  const st = n?.status || 'idle', d = n?.data;
  let html = `<h4>${esc(m.t)} <span class="st ${st}">${STATUS_LABEL[st]}</span></h4><p>${esc(m.about)}</p>`;
  if (st === 'idle' || !d) html += '<div class="empty">This stage has not happened yet in this session.</div>';
  else {
    const rest = { ...d };
    for (const [k, label] of Object.entries(TOKEN_KEYS)) if (typeof d[k] === 'string') { html += tokBox(label, d[k]); delete rest[k]; }
    if (id === 'access' || id === 'idtoken') {
      const c = d.claims || {};
      const rows = [['subject', c.sub], ['audience', c.aud], ['issuer', c.iss], ['client', c.cid], ['scopes', [].concat(c.scp || []).join(' ')], ['issued', c.iat && when(c.iat * 1000)], ['expires', c.exp && when(c.exp * 1000)], ['refresh token', id === 'access' ? d.refresh_token : null]].filter((r) => r[1]);
      html += `<dl class="kv claims">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
      delete rest.claims; delete rest.refresh_token; delete rest.expiresAt;
      if (id === 'access') html += '<div class="note">Everything the agent can do is bounded by this token: its audience is the gateway and nothing else.</div>';
    }
    if (id === 'sts') {
      if (d.consentUrl) html += `<div class="note warn">Okta has no GitHub grant for this user yet, so it needs a one-time consent. <a href="${esc(d.consentUrl)}" target="_blank" rel="noopener" style="color:var(--warn);font-weight:600">Authorize GitHub →</a> then retry.</div>`;
      else if (d.exchange) html += `<div class="note">Confirmed by Okta’s System Log at ${when(Date.parse(d.exchange.at))}: <b>${esc(d.exchange.result)}</b>. The gateway signed in as its own workload identity (${esc(d.exchange.clientAuthType)}), presented this agent’s access token as the subject, and Okta checked delegation link <code>${esc(d.exchange.delegationLinkId)}</code> and resource connection <code>${esc(d.exchange.resourceConnectionId)}</code> before returning a GitHub token in ${esc(d.exchange.responseTimeMs)} ms. No consent prompt appears because you already authorized GitHub earlier${d.consentOnFile ? ` (${when(Date.parse(d.consentOnFile.at))})` : ''}, and Okta kept the grant.</div>`;
      else if (d.reused) html += `<div class="note">Okta’s log shows no new exchange for this call, so the gateway reused a GitHub token it already held. The latest exchange for this agent was at ${when(Date.parse(d.lastExchange.at))}.</div>`;
      else html += `<div class="note warn">${d.logAvailable ? 'The call succeeded, so an exchange happened, but Okta’s System Log has no record of it yet (it can lag by several seconds). This stage will turn green when the record appears.' : 'This happens inside Okta and can’t be observed directly. Okta’s System Log evidence isn’t enabled for this demo, so this stage is shown as inferred.'}</div>`;
      for (const k of ['consentUrl', 'logAvailable', 'checkedAt', 'reused']) delete rest[k];
    }
    if (id === 'ghtoken') {
      const r = d.returned;
      html += `<div class="note warn">The GitHub token is not shown here, by design. ${r ? `Okta’s log records that it was issued at ${when(Date.parse(r.at))}: a ${esc(r.tokenTypes)} returned in ${esc(r.responseTimeMs)} ms.` : 'Okta’s log has no record of it yet.'}${d.reused ? ' This call reused a token the gateway already held.' : ''}</div>`;
      for (const k of ['visible', 'reused']) delete rest[k];
    }
    const left = JSON.stringify(rest, null, 2);
    if (rest && Object.keys(rest).length && left !== '{}') html += `<div class="tokHead"><span>${id === 'discover' || id === 'gateway' || id === 'toolcall' ? 'Observed' : 'More'}</span></div><pre>${esc(left)}</pre>`;
  }
  el.innerHTML = html;
  el.scrollTop = keep;
}
renderFlow();

// Restore the trace carried across the Okta redirect. This must stay last: it needs everything above to be defined.
if (carried) for (const ev of carried.events) renderEvent(ev, true);
