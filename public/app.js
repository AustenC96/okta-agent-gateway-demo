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
// ---------- stage ----------
// Two steps now: the page signs the person in, and the team's agent does everything else (connecting, choosing tools, calling them).
function currentStep() { return state.cfg?.signedIn ? 'ask' : 'login'; }
function render() {
  const picking = needsPersona();
  $('#personas').hidden = !picking;
  $('main').hidden = picking;
  if (picking) { renderPersonas(); return; }
  const cur = currentStep();
  const order = ['login', 'ask'];
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step), c = order.indexOf(cur);
    li.className = i < c ? 'done' : i === c ? 'active' : '';
  });
  const me = currentPersona();
  const first = me ? me.name.split(' ')[0] : 'the user';
  const stage = $('#stage');
  stage.hidden = cur !== 'login';
  if (cur === 'login') {
    const busy = state.busy ? 'disabled' : '';
    $('#stageBody').innerHTML = `<h2>Sign in</h2><p class="lead">The ${esc(me?.agent || 'agent')} acts as ${esc(first)}, not as a shared account.</p><button class="primary" id="go" ${busy}>Sign in with Okta</button>`;
    // The app reads the gateway's sign-in metadata first (discovery), then sends the person to Okta.
    $('#go').onclick = () => run(async () => { await api('/api/discover', {}); location.href = '/auth/login'; });
  }
  renderVerdict();
  renderFlow();
  renderChat();
}

// ---------- chat with the team's agent ----------
// Patterns borrowed from the chat apps people already know: a centred message column, starter prompts above the composer, a composer that
// sends on Enter, and tool use shown as collapsible step rows inside the answer (as Claude and ChatGPT show it).
function md(src) {
  const e = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => e(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const L = String(src || '').split('\n'), out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l || ''), isSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l || '') && /-/.test(l || '');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < L.length;) {
    const l = L[i];
    if (isRow(l) && isSep(L[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < L.length && isRow(L[i])) rows.push(cells(L[i++]));
      out.push(`<div class="tblWrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*[-*]\s+/.test(l)) {
      const it = []; while (i < L.length && /^\s*[-*]\s+/.test(L[i])) it.push(L[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(`<ul>${it.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else if (/^\s*\d+[.)]\s+/.test(l)) {
      const it = []; while (i < L.length && /^\s*\d+[.)]\s+/.test(L[i])) it.push(L[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push(`<ol>${it.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`);
    } else if (/^#{1,4}\s+/.test(l)) { out.push(`<h4>${inline(l.replace(/^#+\s+/, ''))}</h4>`); i++; }
    else if (!l.trim()) i++;
    else {
      const para = [];
      while (i < L.length && L[i].trim() && !/^\s*([-*]\s|\d+[.)]\s|#{1,4}\s)/.test(L[i]) && !(isRow(L[i]) && isSep(L[i + 1]))) para.push(L[i++]);
      if (!para.length) para.push(L[i++]);
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('');
}

let pendingConsent = null; // { url, prompt, opened }
let chatBusy = false;
function renderChat() {
  const box = $('#chat'), me = currentPersona();
  const on = !!(me?.chat && state.cfg?.signedIn);
  box.hidden = !on;
  if (!on) { delete box.dataset.ready; pendingConsent = null; chatBusy = false; return; }
  if (box.dataset.ready) return;
  box.dataset.ready = '1';
  const first = me.name.split(' ')[0], chips = me.chips || { ask: [], breakIt: [] };
  const others = (state.cfg?.personas || []).filter((p) => p.configured && p.key !== me.key);
  box.innerHTML = `
    <div class="chatHead"><div class="chatTitle">${icon('agent')}<div><b>${esc(me.agent)}</b><span>Acting for ${esc(first)} · Claude on Amazon Bedrock AgentCore</span></div></div></div>
    <div class="chatLog" id="chatLog" aria-live="polite">
      <div class="chatEmpty"><h3>What would you like ${esc(first)}’s agent to do?</h3><p>It can only use the tools ${esc(me.gatewayLabel)} gives it.</p></div>
    </div>
    <div class="chips" id="chips">
      <div class="chipRow"><span class="chipLabel">Try asking</span>${chips.ask.map((c) => `<button type="button" class="chip" data-p="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="chipRow"><span class="chipLabel warn">${icon('shield')}Try to break it</span>${chips.breakIt.map((c) => `<button type="button" class="chip warn" data-p="${esc(c)}">${esc(c)}</button>`).join('')}
        ${others.map((p) => `<a class="chip warn" href="/auth/probe/${esc(p.key)}">Sign in to the ${esc(p.agent)}</a>`).join('')}</div>
    </div>
    <form class="composer" id="composer"><input id="chatIn" placeholder="Message ${esc(me.agent)}…" autocomplete="off" maxlength="2000"><button class="send" id="chatSend" aria-label="Send">${'<svg viewBox="0 0 24 24" class="i"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'}</button></form>
    <p class="chatNote">This agent is told to <i>attempt</i> other teams’ tools if you ask, so you see Okta and the gateway refuse, not the model.</p>`;
  const log = $('#chatLog'), send = $('#chatSend'), input = $('#chatIn');
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const clearEmpty = () => log.querySelector('.chatEmpty')?.remove();
  const setBusy = (b) => { chatBusy = b; send.disabled = b; input.disabled = b; box.classList.toggle('busy', b); if (!b) input.focus(); };

  function addUser(text) { clearEmpty(); log.insertAdjacentHTML('beforeend', `<div class="row you"><div class="bubble">${esc(text)}</div></div>`); scroll(); }
  function addAgent() {
    clearEmpty();
    const row = document.createElement('div'); row.className = 'row agent';
    row.innerHTML = `<div class="avatar">${icon('agent')}</div><div class="body"><div class="steps"></div><div class="answer"></div><div class="thinking"><i></i><i></i><i></i></div></div>`;
    log.appendChild(row); scroll();
    return { row, steps: row.querySelector('.steps'), answer: row.querySelector('.answer'), thinking: row.querySelector('.thinking'), text: '' };
  }
  function addStep(m, ev) {
    const attempt = ev.name === 'try_other_tool';
    const nameOf = attempt ? String(ev.input?.tool_name || 'another tool') : ev.name;
    const d = document.createElement('details'); d.className = `step running${attempt ? ' attempt' : ''}`; d.dataset.id = ev.id; d.dataset.started = Date.now();
    d.innerHTML = `<summary><span class="stIcon"></span><span class="stTitle">${attempt ? 'Trying' : 'Using'} <b>${esc(prettyTool({ name: nameOf }))}</b></span><code>${esc(nameOf)}</code><span class="stTime"></span></summary>
      <div class="stBody"><div class="k">Input</div><pre>${esc(JSON.stringify(attempt ? ev.input?.arguments || {} : ev.input, null, 2))}</pre><div class="k stResK" hidden>Result</div><pre class="stRes" hidden></pre></div>`;
    m.steps.appendChild(d);
    d._timer = setInterval(() => {
      const s = Math.round((Date.now() - d.dataset.started) / 1000);
      d.querySelector('.stTime').textContent = s >= 6 ? `${s}s · the demo database may be waking up` : s ? `${s}s` : '';
    }, 1000);
    scroll();
  }
  function finishStep(m, ev) {
    const d = m.steps.querySelector(`details[data-id="${CSS.escape(ev.id)}"]`); if (!d) return;
    clearInterval(d._timer);
    const attempt = d.classList.contains('attempt'), refused = attempt && /GATEWAY_REFUSED/.test(ev.text);
    const consent = /Connection required: visit (https?:\/\/\S+?)(?:\s|$)/.exec(ev.text);
    const bad = ev.status === 'error' || refused;
    d.classList.remove('running'); d.classList.add(consent ? 'consent' : refused ? 'blocked' : bad ? 'err' : 'ok');
    d.querySelector('.stTime').textContent = consent ? 'consent needed' : refused ? 'blocked by the gateway' : bad ? 'failed' : 'done';
    const res = d.querySelector('.stRes'); res.hidden = false; d.querySelector('.stResK').hidden = false;
    res.textContent = refused ? 'The gateway refused: this tool is not exposed to this agent (MCP error -32602, invalid params).' : ev.text.slice(0, 1500);
    if (consent) pendingConsent = { url: consent[1], prompt: m.prompt, opened: false };
  }
  function paint(m) { m.answer.innerHTML = md(m.text); if (m.text) m.thinking.hidden = true; scroll(); }

  async function ask(prompt) {
    setBusy(true);
    const m = addAgent(); m.prompt = prompt;
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
      if (!r.ok) { m.thinking.remove(); m.answer.innerHTML = `<p class="err">${esc((await r.json().catch(() => ({}))).error || `Something went wrong (${r.status}).`)}</p>`; return; }
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === 'text') { m.text += ev.text; paint(m); }
          else if (ev.type === 'tool_call') addStep(m, ev);
          else if (ev.type === 'tool_result') finishStep(m, ev);
          else if (ev.type === 'error') { m.text += `\n\n_${ev.message}_`; paint(m); }
        }
      }
    } catch (e) { m.answer.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    finally {
      m.thinking.remove(); m.steps.querySelectorAll('details.running').forEach((d) => { clearInterval(d._timer); d.classList.remove('running'); });
      if (pendingConsent && pendingConsent.prompt === prompt && !pendingConsent.shown) {
        pendingConsent.shown = true;
        const c = document.createElement('div'); c.className = 'consentCard';
        c.innerHTML = `<b>One-time consent needed.</b> Okta has to ask ${esc(first)} to approve access once.
          <div class="cActs"><a class="btn" target="_blank" rel="noopener" href="${esc(pendingConsent.url)}">Authorize access →</a><button type="button" class="ghost" id="retryBtn">I’ve approved, retry</button></div>
          <div class="muted">When you come back to this tab the question is asked again automatically.</div>`;
        c.querySelector('a').onclick = () => { pendingConsent.opened = true; };
        c.querySelector('#retryBtn').onclick = retry;
        m.row.querySelector('.body').appendChild(c);
      }
      setBusy(false); scroll();
    }
  }
  function retry() {
    if (!pendingConsent || chatBusy) return;
    const { prompt } = pendingConsent; pendingConsent = null;
    addUser(`${prompt}  (asking again)`); ask(prompt);
  }
  function submit(text) {
    const prompt = String(text || '').trim();
    if (!prompt || chatBusy) return;
    input.value = ''; pendingConsent = null; addUser(prompt); ask(prompt);
  }
  $('#composer').onsubmit = (e) => { e.preventDefault(); submit(input.value); };
  box.querySelectorAll('.chip[data-p]').forEach((b) => b.onclick = () => submit(b.dataset.p));
  window.addEventListener('focus', () => { if (pendingConsent?.opened) retry(); });
  input.focus();
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
  let gateway = st('gateway') === 'done' ? 'ok' : st('gateway') === 'error' ? 'blocked' : cur === 'ask' && !v ? 'active' : 'idle';
  let data = st('toolcall') === 'done' ? 'ok' : st('toolcall') === 'waiting' ? 'wait' : st('toolcall') === 'error' ? 'blocked' : cur === 'ask' && !v ? 'active' : 'idle';
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
async function load() {
  state.cfg = await api('/api/config');
  state.discovered = state.cfg.discovered;
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
