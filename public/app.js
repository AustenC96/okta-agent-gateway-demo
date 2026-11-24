const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { cfg: null, discovered: false, tools: null, busy: false, consentUrl: null, verdict: null };
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
// The tool list lives in the page, so it is carried across the trip to Okta and back too; otherwise the page would drop back to "Connect".
const carriedTools = JSON.parse(sessionStorage.getItem('carriedTools') || 'null');
sessionStorage.removeItem('carriedTools');
const seen = [];
let lastId = 0;
// The server says how to follow the trace: a live stream, or short polls on hosts that cannot hold a stream open.
// Either way an event is shown once: ids only ever go up, so anything at or below the last one shown is skipped.
function showLive(ev) { if ((ev.id || 0) > lastId) renderEvent(ev, false); }
(async () => {
  const mode = (await api('/api/transport')).mode;
  if (mode === 'poll') {
    let after = carried ? carried.lastId : (await api('/api/events/poll?init=1')).head || 0;
    const tick = async () => {
      try { const r = await api(`/api/events/poll?after=${after}`); for (const ev of r.events || []) showLive(ev); after = Math.max(after, r.head || 0); } catch { /* try again next tick */ }
      setTimeout(tick, document.hidden ? 4000 : 1000);
    };
    tick();
  } else {
    const es = new EventSource(carried ? `/api/events?after=${carried.lastId}` : '/api/events');
    es.onmessage = (m) => showLive(JSON.parse(m.data));
  }
})();
document.addEventListener('click', (e) => {
  if (e.target.closest('a[href^="/auth/"]')) {
    sessionStorage.setItem('carriedTrace', JSON.stringify({ events: seen, lastId }));
    if (state.tools) sessionStorage.setItem('carriedTools', JSON.stringify(state.tools));
  }
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
      <span class="title">${esc(ev.label)}</span>
      <span class="status">${esc(st)}</span>
      <span class="ms">${ev.ms}ms</span>
    </header>
    <div class="story">${esc(ev.narration)}</div>
    <div class="raw">
      <div class="url">${esc(ev.method)} ${esc(u.host + u.pathname)}</div>
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
  // The newest event that carries a verdict is the answer shown at the top; evidence from Okta's log is attached to it when it arrives.
  if (ev.verdict) state.verdict = { ...ev.verdict, body: ev.response?.body };
  if (ev.evidence && state.verdict) state.verdict.evidence = ev.evidence;
  if (ev.node) { flow.lastNode = ev.node; clearTimeout(flow.timer); flow.timer = setTimeout(refreshFlow, 120); }
  $('#count').textContent = `${++eventCount} call${eventCount === 1 ? '' : 's'}`;
  render();
}
function resetTraceView(message) { state.verdict = null; seen.length = 0; $('#feed').innerHTML = `<div class="empty">${message}</div>`; eventCount = 0; $('#count').textContent = '0 calls'; }
$('#clearBtn').onclick = async () => { const r = await api('/api/events/clear', {}); if (typeof r.head === 'number') lastId = r.head; resetTraceView('Cleared. New calls will appear here.'); };


// ---------- personas ----------
const needsPersona = () => !!state.cfg?.personas?.length && !state.cfg.persona;
const currentPersona = () => state.cfg?.personas?.find((p) => p.key === state.cfg.persona) || null;
async function choosePersona(key) {
  if (state.busy) return;
  state.busy = true;
  try {
    const r = await api('/api/persona', { key });
    lastId = r.head || 0; // follow the server's numbering from here, whatever it was before
    state.tools = null; state.consentUrl = null; state.discovered = false;
    flow.nodes = null; flow.sig = {}; flow.selected = null; flow.pinned = false; flow.lastNode = null;
    sessionStorage.removeItem('carriedTrace');
    resetTraceView('Calls appear here as they happen.');
  } finally { state.busy = false; await load(); }
}
function renderPersonas() {
  const box = $('#personas');
  const initials = (n) => n.split(' ').map((w) => w[0]).join('').slice(0, 2);
  const row = (k, v) => `<span class="row"><span class="k">${k}:</span><span class="v">${esc(v)}</span></span>`;
  box.innerHTML = `<h2>Sign in as</h2>
    <div class="personaGrid">${state.cfg.personas.map((p) => `
      <button class="personaCard" data-key="${esc(p.key)}" data-dept="${esc(p.department)}" ${p.configured ? '' : 'disabled'}>
        <span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="pname">${esc(p.name)}</span>
        <span class="rows">${row('Department', p.department)}${row('Agent', p.agent)}${row('Gateway', p.gatewayLabel)}</span>
        <span class="go">${p.configured ? '→' : 'Not set up'}</span>
      </button>`).join('')}</div>`;
  box.querySelectorAll('button[data-key]').forEach((b) => b.onclick = () => choosePersona(b.dataset.key));
}
// The two governance checks, framed as layers of defence: Okta decides who may use which agent, the gateway decides which tools exist.
function governHtml(busy) {
  const me = currentPersona();
  const others = (state.cfg?.personas || []).filter((p) => p.configured && p.key !== me?.key);
  const tools = me ? me.blockedTools : [{ name: 'GitHubMCP_merge_pull_request', label: 'merge_pull_request' }, { name: 'GitHubMCP_delete_file', label: 'delete_file' }];
  const agentCard = me && others.length ? `<div class="govCard"><span class="layer">Layer 1 · Okta</span><h4>Another team’s agent</h4>
    <div class="govBtns">${others.map((p) => `<a class="btn outline" href="/auth/probe/${esc(p.key)}">Try the ${esc(p.agent)}</a>`).join('')}</div></div>` : '';
  const toolCard = `<div class="govCard"><span class="layer">Layer 2 · Gateway</span><h4>A tool it doesn’t have</h4>
    <div class="govBtns">${tools.map((t) => `<button class="outline" data-blocked="${esc(t.name)}" ${busy}>${esc(t.label)}</button>`).join('')}</div></div>`;
  return `<h3 class="govTitle">Now try to break it</h3><div class="govGrid">${agentCard}${toolCard}</div>`;
}

// ---------- stage ----------
function currentStep() {
  if (!state.discovered) return 'discover';
  if (!state.cfg?.signedIn) return 'login';
  if (!state.tools) return 'session';
  return 'tools';
}
function render() {
  const picking = needsPersona();
  $('#personas').hidden = !picking;
  $('main').hidden = picking;
  if (picking) { renderPersonas(); return; }
  const cur = currentStep();
  const order = ['discover', 'login', 'session', 'tools'];
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step), c = order.indexOf(cur);
    li.className = i < c ? 'done' : i === c ? 'active' : '';
  });
  const me = currentPersona();
  const first = me ? me.name.split(' ')[0] : 'the user';
  const body = $('#stageBody');
  const busy = state.busy ? 'disabled' : '';
  const consent = state.consentUrl ? `<div class="consent">One-time consent needed. <a href="${esc(state.consentUrl)}" target="_blank" rel="noopener">Authorize access →</a> then retry.</div>` : '';
  if (cur === 'discover') {
    body.innerHTML = `<h2>Discover the gateway</h2><p class="lead">The agent starts with one URL and no credentials.</p><button class="primary" id="go" ${busy}>Discover</button>`;
    $('#go').onclick = () => run(async () => { await api('/api/discover', {}); });
  } else if (cur === 'login') {
    body.innerHTML = `<h2>Sign in</h2><p class="lead">The agent acts as ${esc(first)}, not as a shared account.</p><a class="btn" href="/auth/login">Sign in with Okta</a>`;
  } else if (cur === 'session') {
    body.innerHTML = `<h2>Connect</h2><p class="lead">Open a session and ask which tools ${me ? esc(first) + '’s agent' : 'the agent'} may use.</p><button class="primary" id="go" ${busy}>Connect</button>${consent}`;
    $('#go').onclick = () => run(async () => {
      state.consentUrl = null;
      const init = await api('/api/mcp/initialize', {});
      if (init.error) return;
      const t = await api('/api/mcp/tools', {});
      state.consentUrl = t.consentUrl || null;
      if (t.result?.tools) state.tools = t.result.tools;
    });
  } else {
    const tiles = state.tools.length ? state.tools.map((t, i) => {
      const ro = isReadOnly(t);
      return `<div class="tool"><div class="tTop"><span class="tName">${esc(prettyTool(t))}</span><span class="chip2 ${ro ? 'read' : 'write'}">${ro ? 'Read' : 'Write'}</span></div>
        <code>${esc(t.name)}</code>
        ${ro ? `<button data-i="${i}" ${busy} title="Sample input: ${esc(JSON.stringify(sampleArgs(t)))}">Run</button>` : '<button disabled title="This tool changes data, so the demo does not run it">Run</button>'}</div>`;
    }).join('') : '<p class="lead">The gateway returned no tools. Ask the admin to expose some on the virtual MCP server.</p>';
    body.innerHTML = `<div class="sectionHead"><h2>${me ? `Tools ${esc(first)} can use` : 'Tools available'}</h2><span>${state.tools.length} on ${esc(me?.gatewayLabel || 'this gateway')}</span></div><div class="tools">${tiles}</div>${governHtml(busy)}`;
    body.querySelectorAll('.govern button[data-blocked],.govCard button[data-blocked]').forEach((b) => b.onclick = () => callBlocked(b.dataset.blocked));
    body.querySelectorAll('.tool button[data-i]').forEach((b) => b.onclick = () => callTool(state.tools[b.dataset.i]));
  }
  renderVerdict();
  renderFlow();
}
const prettyTool = (t) => { const s = baseName(t).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

// ---------- the path: who is acting, and the road a request takes ----------
const ICON = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  agent: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
  gateway: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  data: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  shieldx: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
  log: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7M9 8h3"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
// Each stop is idle, active (the next thing to do), ok, wait (needs the user) or blocked. They come from what the server observed.
function pathState() {
  const n = flow.nodes || {}, st = (id) => n[id]?.status, v = state.verdict, cur = currentStep();
  const signed = !!state.cfg?.signedIn;
  let gateway = st('gateway') === 'done' ? 'ok' : st('gateway') === 'error' ? 'blocked' : cur === 'session' ? 'active' : 'idle';
  let data = st('toolcall') === 'done' ? 'ok' : st('toolcall') === 'waiting' ? 'wait' : st('toolcall') === 'error' ? 'blocked' : cur === 'tools' && !v ? 'active' : 'idle';
  if (v?.kind === 'blocked-gateway') gateway = 'blocked';
  if (v?.kind === 'blocked-server') data = 'blocked';
  const signin = v?.kind === 'blocked-okta' ? 'blocked' : st('access') === 'done' ? 'ok' : st('access') === 'error' ? 'blocked' : 'idle';
  const exch = ['done', 'inferred'].includes(st('sts')) ? 'ok' : st('sts') === 'waiting' ? 'wait' : st('sts') === 'error' ? 'blocked' : 'idle';
  const audit = n.sts?.data?.exchange || n.sts?.data?.oktaGatewayEvents?.length || v?.evidence ? 'ok' : 'idle';
  return { person: signed ? 'ok' : cur === 'login' ? 'active' : 'idle', agent: signed ? 'ok' : 'idle', gateway, data, signin, exch, audit };
}
function renderPath() {
  const box = $('#path');
  if (!box || needsPersona()) return;
  const me = currentPersona(), s = pathState();
  const initials = me ? me.name.split(' ').map((w) => w[0]).join('').slice(0, 2) : '';
  const node = (kind, ic, title, sub, status, badge) => `<div class="pnode ${status}" data-kind="${kind}"><span class="pBadge">${badge[status] || ''}</span><span class="pIcon">${icon(ic)}</span><span class="pText"><b>${esc(title)}</b><small>${esc(sub)}</small></span></div>`;
  const arrow = (a, b) => `<div class="pArrow ${b === 'blocked' ? 'bad' : ['ok'].includes(a) && ['ok', 'active', 'wait'].includes(b) ? 'lit' : ''}"></div>`;
  const attempt = state.verdict?.kind === 'blocked-okta' && state.verdict.target;
  const nodes = attempt ? [
    node('person', 'user', me?.name || 'The user', me?.department || '', 'ok', { ok: '✓ Signed in' }),
    node('agent', 'agent', attempt.agent, `Not assigned to ${me ? me.name.split(' ')[0] : 'this user'}`, 'blocked', { blocked: '✕ Not assigned' }),
    node('gateway', 'gateway', attempt.gateway, 'Never reached', 'idle dim', {}),
    node('data', 'data', attempt.resource, 'Never reached', 'idle dim', {}),
  ] : [
    node('person', 'user', me?.name || state.cfg?.tokenInfo?.claims?.sub || 'The user', me?.department || (s.person === 'ok' ? 'Signed in' : 'Not signed in'), s.person, { ok: '✓ Signed in' }),
    node('agent', 'agent', me?.agent || 'The agent', me ? `Acting for ${me.name.split(' ')[0]}` : 'MCP client', s.agent, { ok: '✓ Authenticated' }),
    node('gateway', 'gateway', me?.gatewayLabel || 'Gateway', me?.gatewayPath || new URL(state.cfg?.gatewayUrl || location.href).pathname, s.gateway, { ok: '✓ Connected', blocked: '✕ Blocked' }),
    node('data', 'data', me?.resourceLabel || 'Downstream service', 'Behind the gateway', s.data, { ok: '✓ Reached', blocked: '✕ Blocked', wait: '! Needs consent' }),
  ];
  const chip = (label, st) => `<span class="chip ${st}">${label}</span>`;
  box.innerHTML = `<div class="pathRow">${nodes[0]}${arrow(s.person, attempt ? 'blocked' : s.agent)}${nodes[1]}${arrow(attempt ? 'idle' : s.agent, s.gateway)}${nodes[2]}${arrow(attempt ? 'idle' : s.gateway, s.data)}${nodes[3]}</div>
    <div class="oktaBar" role="button" tabindex="0" title="Open the token flow"><span class="ok-l">OKTA</span>${chip('Sign-in policy', s.signin)}${chip('Token exchange', attempt ? 'idle' : s.exch)}${chip('Audit log', attempt ? 'idle' : s.audit)}<span class="hint">Open the token flow ›</span></div>`;
}
$('#path').addEventListener('click', (e) => { if (e.target.closest('.oktaBar')) setDrawer(true); });

// ---------- the verdict: one plain answer to the last thing that was tried ----------
function preview(text) {
  let data; try { data = JSON.parse(text); } catch { return text ? `<pre>${esc(text.slice(0, 700))}</pre>` : ''; }
  const cell = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));
  const pretty = (k) => k.replace(/_/g, ' ');
  const kv = (o) => `<dl class="kvgrid">${Object.entries(o).slice(0, 8).map(([k, v]) => `<dt>${esc(pretty(k))}</dt><dd title="${esc(cell(v))}">${esc(cell(v))}</dd>`).join('')}</dl>`;
  if (Array.isArray(data) && data.length === 1 && data[0] && typeof data[0] === 'object') return kv(data[0]);
  if (Array.isArray(data) && data.length && data.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    const cols = Object.keys(data[0]).slice(0, 5);
    return `<div class="tbl"><table><thead><tr>${cols.map((c) => `<th>${esc(pretty(c))}</th>`).join('')}</tr></thead><tbody>${data.slice(0, 5).map((r) => `<tr>${cols.map((c) => `<td title="${esc(cell(r[c]))}">${esc(cell(r[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table>${data.length > 5 ? `<div class="more">+${data.length - 5} more rows</div>` : ''}</div>`;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) return kv(data);
  return `<pre>${esc(String(text).slice(0, 700))}</pre>`;
}
function renderVerdict() {
  const el = $('#verdict'), v = state.verdict;
  if (!v) {
    el.className = 'card verdict none';
    el.innerHTML = `<div class="vHead"><div class="vIcon">${icon('shield')}</div><div><div class="vTitle">No result yet</div><div class="vDetail">Run a tool or try a check. The answer appears here.</div></div></div>`;
    return;
  }
  const ic = { allowed: 'check', consent: 'alert', waking: 'alert', problem: 'alert' }[v.kind] || 'shieldx';
  const text = (v.body?.result?.content || []).map((c) => c.text).filter(Boolean).join('\n');
  el.className = `card verdict v-${v.kind}`;
  el.innerHTML = `<div class="vHead"><div class="vIcon">${icon(ic)}</div><div><div class="vTitle">${esc(v.title)}</div><div class="vDetail">${esc(v.detail || '')}</div></div></div>
    ${v.kind === 'allowed' && text ? preview(text) : ''}
    ${v.kind === 'consent' && v.url ? `<div><a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener">Open the consent page →</a></div>` : ''}
    ${v.evidence ? `<div class="evidence">${icon('log')}<span>${esc(v.evidence)}</span></div>` : ''}`;
}

// ---------- under the hood: the token flow, in a side sheet ----------
function setDrawer(open) {
  $('#drawer').classList.toggle('open', open); $('#scrim').classList.toggle('open', open);
  $('#drawer').setAttribute('aria-hidden', String(!open));
  if (open) renderFlow();
}
$('#scrim').onclick = () => setDrawer(false);
$('#drawerClose').onclick = () => setDrawer(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });

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
  // The demo CRM and HR data
  search_customers: { query: 'Northwind' },
  get_customer: { customer_id: 'C-1001' },
  list_deals: { customer_id: 'C-1001' },
  list_employees: {},
  get_employee: { employee_id: 'E-2005' },
  get_compensation: { employee_id: 'E-2005' },
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
  });
}
async function callBlocked(tool) {
  run(async () => { state.consentUrl = null; await api('/api/mcp/blocked', { tool }); });
}
async function run(fn) { state.busy = true; render(); try { await fn(); } finally { state.busy = false; await load(); } }
async function load() {
  state.cfg = await api('/api/config');
  state.discovered = state.cfg.discovered;
  if (carriedTools && state.cfg.signedIn && !state.tools) state.tools = carriedTools;
  const me = currentPersona();
  const t = state.cfg.tokenInfo;
  const initials = me ? me.name.split(' ').map((w) => w[0]).join('').slice(0, 2) : '';
  if (needsPersona()) $('#who').innerHTML = '';
  else {
    $('#who').innerHTML = (me ? `<span class="pill" data-dept="${esc(me.department)}"><span class="av">${esc(initials)}</span>${esc(me.name)} <small>${esc(me.department)}</small></span>` : (t ? `<span class="pill"><span class="av">${esc((t.claims?.sub || '?')[0].toUpperCase())}</span>${esc(t.claims?.sub || 'signed in')}</span>` : ''))
      + '<button class="ghost" id="hood">Under the hood</button>'
      + (me ? '<button class="ghost" id="switch">Switch persona</button>' : (t ? '<button class="ghost" id="out">Sign out</button>' : ''));
    $('#hood').onclick = () => setDrawer(true);
    if (me) $('#switch').onclick = () => choosePersona(null);
    // Sign out wipes the server session, then reloads so the page is exactly as on first load.
    if (!me && t) $('#out').onclick = async () => { await api('/api/logout', {}); sessionStorage.removeItem('carriedTrace'); location.reload(); };
  }
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
  ghtoken:  { x: 10,  y: 210, t: 'Downstream token',   s: 'never reaches the agent', about: 'The downstream credential the gateway injects into the outbound call to GitHub. It is held by Okta and the gateway, never by the agent or this app, which is the point: a prompt-injected or compromised agent has nothing to leak. Because it is invisible by design, this stage shows Okta’s record that it was issued, not the token.' },
  toolcall: { x: 10,  y: 310, t: 'Tool call',         s: 'via the gateway', about: 'The gateway forwards the tool call to GitHub with the downstream token and relays the answer. The calls below are what this app sent and what came back.' },
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
  renderPath();
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
  if (!m) { el.innerHTML = '<div class="empty">Click a stage to see its tokens and calls.</div>'; return; }
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
