import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tenantNameFrom } from './tenant.js';
import { createMemoryStore } from './store.js';
import { configFromEnv } from './config.js';
import { publicPersona } from './personas.js';
import { callVerdict, blockedVerdict, probeVerdict } from './verdicts.js';
import { Redis } from '@upstash/redis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- helpers ----------
const mask = (s, keep = 10) => (typeof s === 'string' && s.length > keep + 6 ? `${s.slice(0, keep)}…[${s.length} chars]` : s);
function decodeJwt(t) {
  try {
    const [h, p] = t.split('.');
    const j = (x) => JSON.parse(Buffer.from(x, 'base64url').toString('utf8'));
    return { header: j(h), claims: j(p) };
  } catch { return null; }
}
function redactBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (/^(access_token|id_token|refresh_token|client_secret|code|code_verifier|subject_token)$/i.test(k)) out[k] = mask(v);
    else if (v && typeof v === 'object') out[k] = redactBody(v);
    else out[k] = v;
  }
  return out;
}
function redactHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /^authorization$/i.test(k) ? String(v).replace(/^(Bearer|SSWS)(\s+)(.+)$/i, (_, scheme, sp, tok) => scheme + sp + mask(tok)) : v;
  }
  return out;
}
function parseMaybeSse(text, contentType = '') {
  if (!text) return null;
  if (contentType.includes('text/event-stream')) {
    const msgs = text.split(/\n\n+/).map((blk) => blk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean);
    for (const m of msgs.reverse()) { try { return JSON.parse(m); } catch { /* keep looking */ } }
    return { raw: text.slice(0, 2000) };
  }
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 2000) }; }
}

const defaultNarration = (ev) =>
  ev.error ? `The request to ${new URL(ev.url).host} failed before getting a response: ${ev.error}.`
    : `${ev.method} ${new URL(ev.url).pathname} returned HTTP ${ev.response.status} in ${ev.ms} ms.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STS_EVENT = 'app.oauth2.token.grant.oauth_sts';
const summarizeLog = (e) => {
  const d = e.debugContext?.debugData || {};
  return {
    at: e.published, eventType: e.eventType, result: e.outcome?.result, reason: e.outcome?.reason || undefined,
    user: (e.target || []).find((t) => t.type === 'User')?.alternateId || undefined,
    userId: (e.target || []).find((t) => t.type === 'User')?.id || undefined,
    actor: e.actor?.alternateId && e.actor.alternateId !== 'unknown' ? e.actor.alternateId : e.actor?.id, actorType: e.actor?.type,
    message: e.displayMessage || undefined,
    tokenExchangeType: d.tokenExchangeType, clientAuthType: d.clientAuthType, subjectTokenClientId: d.subjectTokenClientId,
    subjectTokenIssuer: d.subjectTokenIssuer, delegationLinkId: d.delegationLinkId, resourceConnectionId: d.resourceConnectionId,
    responseTimeMs: d.responseTime ? Number(d.responseTime) : undefined, returnedTokenTypes: d.returnedTokenTypes,
    targetResourceOrn: d.targetResourceOrn, persistedTokenTypes: d.persistedTokenTypes, grantType: d.grantType,
  };
};

// Finds the link Okta returns when the user must consent first. It arrives as an MCP error, or as plain text in a tool result
// ("Connection required: visit https://.../oauth2/v1/sts/redirect?dataHandle=..."), so search the whole response.
export const findConsentUrl = (b) => JSON.stringify(b || {}).match(/https?:\/\/[^"\\\s]+(?:consent|interaction|authorize|sts\/redirect)[^"\\\s]*/i)?.[0] || null;

// The client secret is POSTed to a URL that a remote server told us about, so every such URL is checked first.
// Unless local hosts are allowed (local development), it must be https and must not point at a private, loopback,
// link-local or cloud-metadata address. Only literal addresses and well-known names can be recognised here; a hostname
// that merely resolves to a private address is not caught without a DNS lookup.
export function safeUrl(raw, { allowLocal = false } = {}) {
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  if (allowLocal) return ['http:', 'https:'].includes(u.protocol) ? u : null;
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return null;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
  } else if (h.includes(':')) {
    if (h === '::1' || h === '::' || /^(fc|fd|fe[89ab])/.test(h) || h.startsWith('::ffff:')) return null;
  } else if (/^\d+$/.test(h) || /^0x/i.test(h)) return null;
  return u;
}

// Keeps the path of a callback URL but masks the one-time code and state in its query string.
export function redactUrl(raw) {
  try {
    const u = new URL(raw, 'http://x');
    for (const k of ['code', 'state']) if (u.searchParams.has(k)) u.searchParams.set(k, mask(u.searchParams.get(k), 4));
    return u.pathname + (u.search ? decodeURIComponent(u.search) : '');
  } catch { return String(raw).split('?')[0]; }
}

// Okta's System Log is org-wide, so a log entry is only shown to a visitor if it names that visitor. The exchange lists
// the signed-in person as a User target (login in alternateId, Okta id in id); match either against the visitor's own
// token claims. Fails closed: no identity, or an entry that names nobody, means no match.
export function isMine(e, accessClaims, idClaims) {
  const mine = new Set([accessClaims?.sub, accessClaims?.uid, idClaims?.sub, idClaims?.email, idClaims?.preferred_username]
    .filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()));
  return [e?.user, e?.userId].some((x) => typeof x === 'string' && mine.has(x.toLowerCase()));
}

// Status of the two stages that happen inside Okta, from what Okta’s log said (pure, so it can be tested).
export function stsStatus({ sts, consentUrl, callOk }) {
  if (consentUrl) return 'waiting';
  if (sts?.exchange) return sts.exchange.result === 'SUCCESS' ? 'done' : 'error';
  if (sts?.reused) return 'done';
  return callOk ? 'inferred' : 'idle';
}

// The platform registers /callback on the client it creates; the single-tenant setup registers /authorization-code/callback.
const CALLBACK_PATHS = ['/authorization-code/callback', '/callback'];

// Builds one self-contained app. All mutable state (trace, discovery results, STS evidence) lives inside this closure,
// so each call gets its own state and nothing leaks between instances.
export function createApp(config) {
  const resolution = config.resolution || { strategy: 'none' };
  const allowLocal = config.allowLocal ?? true; // local development: plain http and loopback hosts are fine
  // A tenant is one demo's settings. With no getTenant, the one configured tenant is served as 'default'.
  const staticTenant = config.gatewayUrl && { name: 'default', orgUrl: config.orgUrl, gatewayUrl: config.gatewayUrl, clientId: config.clientId, clientSecret: config.clientSecret, callbackPath: config.callbackPath, logToken: config.logToken, origin: config.origin };
  const personaMap = new Map((config.personas || []).map((p) => [p.key, p]));
  const personaTenant = (p) => ({ name: p.key, orgUrl: config.orgUrl, gatewayUrl: p.gatewayUrl, clientId: p.clientId, clientSecret: p.clientSecret, callbackPath: p.callbackPath, logToken: config.logToken, origin: config.origin, persona: p });
  const baseTenant = config.getTenant || (async (name) => (name === 'default' ? staticTenant : null));
  // A chosen persona is just a named tenant: its own agent client and its own gateway.
  const rawTenant = async (name) => (personaMap.has(name) ? (personaMap.get(name).configured ? personaTenant(personaMap.get(name)) : null) : baseTenant(name));
  const getTenant = async (name) => {
    const t = await rawTenant(name);
    if (!t) return null;
    const origin = t.origin || config.origin || `http://localhost:${config.port}`;
    const gw = new URL(t.gatewayUrl);
    return { ...t, name, origin, redirectUri: `${origin}${t.callbackPath || '/authorization-code/callback'}`, gatewayOrigin: gw.origin, gatewayPath: gw.pathname };
  };

  // ---------- event log (every real HTTP call lands here) ----------
  // Events live in the store, one trace per browser session, so a visitor only ever sees their own calls and the trace
  // survives across server instances when the store is shared. Streaming listeners are in-process by nature.
  const store = config.store || createMemoryStore();
  const defer = config.defer || ((p) => p.catch(() => {}));
  const listeners = new Map(); // sid -> Set of send(ev) functions
  async function emit(sid, ev) {
    ev.ts = new Date().toISOString();
    await store.append(sid, ev);
    for (const send of listeners.get(sid) || []) send(ev);
    return ev;
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // A traced fetch: performs the real request and emits a structured event.
  async function traced({ sid, step, node, label, method = 'GET', url, headers = {}, body, form, narrate, outcomeOf, verdictOf }) {
    const started = Date.now();
    const reqHeaders = { ...headers };
    let payload;
    let reqBody;
    if (form) {
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
      reqBody = redactBody(form);
    } else if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
      reqBody = body;
    }
    let res, text = '', error;
    try {
      res = await fetch(url, { method, headers: reqHeaders, body: payload, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      text = await res.text();
    } catch (e) { error = e; }
    const ms = Date.now() - started;
    const ct = res?.headers.get('content-type') || '';
    const parsed = res ? parseMaybeSse(text, ct) : null;
    const resHeaders = res ? Object.fromEntries(res.headers.entries()) : {};
    const ev = {
      step, node, label, method, url,
      request: { headers: redactHeaders(reqHeaders), body: reqBody },
      response: res ? { status: res.status, statusText: res.statusText, headers: resHeaders, body: redactBody(parsed) } : null,
      ms, error: error ? String(error.cause?.message || error.message) : null,
    };
    ev.narration = narrate ? narrate({ ev, res, parsed, resHeaders }) : defaultNarration(ev);
    if (verdictOf && !error) ev.verdict = verdictOf({ ev, res, parsed });
    ev.outcome = error ? 'error' : outcomeOf ? outcomeOf({ ev, parsed }) : res.status < 300 ? 'ok' : res.status === 401 || res.status === 403 || res.status === 400 ? 'denied' : 'error';
    await emit(sid, ev);
    return { res, parsed, resHeaders, ev };
  }

  // ---------- app ----------
  const app = express();
  // Express 4 ignores promise rejections from async handlers, which would hang the request (or crash the process) when the
  // store is a network service. Route every handler through one place that hands failures to the error middleware.
  for (const m of ['get', 'post']) {
    const orig = app[m].bind(app);
    app[m] = (path, ...fns) => (fns.length ? orig(path, ...fns.map((f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next))) : orig(path));
  }
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  // Platform webhooks carry no cookie and name their own demo, so they sit before the session and tenant middleware.
  if (config.hooks) app.use('/hooks', config.hooks);
  app.use(express.json());
  // Scripts and styles do not need a session, so serve them before it; the page itself is served after the tenant check below.
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));
  // Client ID Metadata Document: lets Okta register this app as a CIMD client whose client_id is this URL. It is public metadata,
  // needs no session or tenant, and is served before both. A public client: no secret, PKCE protects the code exchange.
  if (config.origin) {
    const cimdUrl = `${config.origin}/cimd.json`;
    app.get('/cimd.json', (_req, res) => {
      res.set('Cache-Control', 'public, max-age=300');
      res.json({
        client_id: cimdUrl, client_name: 'Agent Gateway: Interactive Flow Demo', client_uri: config.origin,
        redirect_uris: [`${config.origin}/callback`], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none',
      });
    });
  }
  app.use(session({
    store: store.sessionStore(), secret: config.sessionSecret || crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: true,
    cookie: { sameSite: 'lax', httpOnly: true, secure: !!config.origin && config.origin.startsWith('https:') },
  }));
  // Responses carry tokens and one-time codes, so they must never be cached by the browser or a proxy.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Resolve which demo this request is for. The OAuth callback always uses the tenant the sign-in started under,
  // never anything in its own query string, and switching demos drops the previous demo's tokens.
  const resetAuth = async (req) => {
    Object.assign(req.session, { tokens: null, mcpSessionId: null, pkce: null, discovered: false, returnedFromOkta: false, flow: null });
    await store.drop('sts:' + req.sessionID);
  };
  app.use(async (req, res, next) => {
    try {
      let name;
      if (CALLBACK_PATHS.includes(req.path) && req.session.tenant) name = req.session.tenant;
      else {
        const r = tenantNameFrom(req, resolution);
        if (r.invalid) return res.status(400).json({ error: 'Invalid demo name' });
        name = r.name || (resolution.strategy === 'query' && req.session.tenant) || (personaMap.size && req.session.persona) || 'default';
      }
      const tenant = await getTenant(name);
      if (!tenant) return res.status(404).json({ error: 'Unknown demo' });
      if (req.session.tenant && req.session.tenant !== name) await resetAuth(req);
      req.session.tenant = name;
      req.tenant = tenant;
      next();
    } catch (e) { next(e); }
  });
  app.use(express.static(path.join(__dirname, 'public')));

  // Okta System Log evidence arrives seconds after the HTTP response is sent, and express-session only saves at response time,
  // so anything written later would be lost. Keep it here, keyed by session id.
  const F = (req) => (req.session.flow ||= { gateway: { calls: [] }, toolCalls: [], sts: null, stsConsent: null });
  // Public metadata the gateway published, cached per tenant so one demo's discovery never answers for another's.
  const discovery = new Map();
  const disc = (req) => { let d = discovery.get(req.tenant.name); if (!d) discovery.set(req.tenant.name, d = {}); return d; };

  app.get('/api/config', (req, res) => {
    const t = req.session.tokens;
    res.json({
      gatewayUrl: req.tenant.gatewayUrl,
      personas: [...personaMap.values()].map(publicPersona), persona: req.session.persona || null,
      discovered: !!req.session.discovered && !!disc(req).asMeta, signedIn: !!t, tokenInfo: t ? tokenInfo(t) : null, mcpSessionId: req.session.mcpSessionId || null,
    });
  });
  // Choosing a persona (or null to go back to the picker) always starts that persona from a clean slate.
  app.post('/api/persona', async (req, res) => {
    const key = req.body?.key ?? null;
    if (key !== null && !(personaMap.get(key)?.configured)) return res.status(400).json({ error: 'That persona is not set up' });
    await resetAuth(req);
    await store.clear(req.sessionID); // event numbers keep rising, so the page can tell new events from old ones
    req.session.persona = key;
    // head: where this session's event numbering is now. The page resumes from it, so a server restart (which restarts the numbering) cannot leave an open page ignoring new events.
    res.json({ ok: true, persona: key, head: await store.head(req.sessionID) });
  });
  function tokenInfo(t) {
    const d = decodeJwt(t.access_token);
    return {
      claims: d?.claims || null, header: d?.header || null,
      expiresAt: t.obtained_at + (t.expires_in || 0) * 1000, scope: t.scope, hasRefresh: !!t.refresh_token,
      idClaims: t.id_token ? decodeJwt(t.id_token)?.claims : null,
    };
  }

  // How the browser should follow the trace: a long-lived stream, or short polls (serverless hosts cannot hold a stream open).
  app.get('/api/transport', (_req, res) => res.json({ mode: config.transport === 'poll' ? 'poll' : 'stream' }));

  // Polling form: returns what happened after a given id. With init=1 it only reports the current position, so a fresh page
  // load starts empty exactly like the stream does.
  app.get('/api/events/poll', wrap(async (req, res) => {
    const sid = req.sessionID;
    if (req.query.init) return res.json({ events: [], head: await store.head(sid) });
    const after = Number(req.query.after) || 0;
    const events = await store.list(sid, after);
    res.json({ events, head: events.length ? events[events.length - 1].id : after });
  }));

  // live event stream (new events only; the feed starts empty on every page load)
  app.get('/api/events', wrap(async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const sid = req.sessionID;
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    // Subscribe before replaying so nothing slips between the two; ids let the client ignore any overlap.
    const set = listeners.get(sid) || listeners.set(sid, new Set()).get(sid);
    let replaying = true; const queued = []; let top = 0;
    const live = (ev) => { if (replaying) queued.push(ev); else if (ev.id > top) { top = ev.id; send(ev); } };
    set.add(live);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); set.delete(live); if (!set.size) listeners.delete(sid); });
    // A fresh page load starts empty. The only exception is returning from the Okta redirect:
    // the client passes ?after=<last id it showed> so it receives just the calls it missed.
    const after = Number(req.query.after);
    top = Number.isFinite(after) ? after : await store.head(sid);
    if (Number.isFinite(after)) for (const ev of await store.list(sid, after)) { top = Math.max(top, ev.id); send(ev); }
    replaying = false;
    for (const ev of queued) if (ev.id > top) { top = ev.id; send(ev); }
  }));
  // Called on every page load. Coming back from Okta keeps the walkthrough where it was (the callback set
  // returnedFromOkta); any other load, such as a manual refresh, restarts it at step 1.
  app.post('/api/page-load', wrap(async (req, res) => {
    const returned = !!req.session.returnedFromOkta;
    req.session.returnedFromOkta = false;
    // A plain load is a fresh start, which for personas means back to the picker.
    if (!returned) { req.session.discovered = false; req.session.flow = null; req.session.persona = null; await store.drop('sts:' + req.sessionID); }
    res.json({ returned });
  }));
  app.post('/api/events/clear', wrap(async (req, res) => { await store.clear(req.sessionID); res.json({ ok: true, head: await store.head(req.sessionID) }); }));

  // Step 1: discovery. First poke the gateway with no credentials, then follow what it tells us.
  app.post('/api/discover', async (req, res) => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-gateway-demo', version: '1.0.0' } } };
    const probe = await traced({
      sid: req.sessionID, step: 'discover', node: 'discover', label: 'Knock on the gateway with no credentials', method: 'POST', url: req.tenant.gatewayUrl,
      headers: { Accept: 'application/json, text/event-stream' }, body: init,
      narrate: ({ ev, resHeaders }) => {
        if (ev.error) return `Could not reach the gateway: ${ev.error}.`;
        if (ev.response.status === 401) {
          const wa = resHeaders['www-authenticate'] || '';
          return `The gateway answered 401 Unauthorized, which is what we want to see. It will not talk to anonymous callers. Its WWW-Authenticate header ${wa.includes('resource_metadata') ? 'tells the client where to find its OAuth metadata' : 'did not include a metadata pointer'}. This is how any MCP client discovers how to sign in.`;
        }
        return `Unexpected ${ev.response.status} from an unauthenticated call. The gateway should have returned 401.`;
      },
    });
    const wa = probe.resHeaders['www-authenticate'] || '';
    const m = /resource_metadata="([^"]+)"/.exec(wa);
    const prUrl = m?.[1] || `${req.tenant.gatewayOrigin}/.well-known/oauth-protected-resource${req.tenant.gatewayPath}`;
    if (!safeUrl(prUrl, { allowLocal })) return res.status(502).json({ error: 'The gateway pointed at a metadata URL that is not allowed' });
    const pr = await traced({
      sid: req.sessionID, step: 'discover', node: 'discover', label: 'Read the gateway’s protected-resource metadata', url: prUrl,
      narrate: ({ ev, parsed }) => ev.error ? `Metadata fetch failed: ${ev.error}.` : ev.response.status !== 200 ? `Metadata endpoint returned ${ev.response.status}.`
        : `The gateway says it is the protected resource “${new URL(parsed.resource).pathname}” and that tokens must come from ${parsed.authorization_servers?.[0]}. Supported scopes: ${(parsed.scopes_supported || []).join(', ')}. The client now knows exactly who to ask for a token.`,
    });
    const d = disc(req);
    d.prMeta = pr.parsed;
    const asBase = d.prMeta?.authorization_servers?.[0];
    if (!asBase) return res.status(502).json({ error: 'No authorization server advertised by gateway' });
    const asUrl = safeUrl(asBase, { allowLocal });
    if (!asUrl) return res.status(502).json({ error: 'The advertised authorization server is not an allowed address' });
    if (!allowLocal && asUrl.origin !== new URL(req.tenant.orgUrl).origin && !(req.tenant.authOrigins || []).includes(asUrl.origin)) {
      return res.status(502).json({ error: 'The advertised authorization server is not this tenant’s Okta org' });
    }
    const as = await traced({
      sid: req.sessionID, step: 'discover', node: 'discover', label: 'Read the authorization server’s metadata', url: `${asBase}/.well-known/oauth-authorization-server`,
      narrate: ({ ev, parsed }) => ev.error ? `Failed: ${ev.error}.` : ev.response.status !== 200 ? `Returned ${ev.response.status}.`
        : `This is a dedicated Okta custom authorization server created for the gateway. It supports ${(parsed.grant_types_supported || []).length} grant types and PKCE methods ${(parsed.code_challenge_methods_supported || []).join(', ')}. We will use the authorization endpoint ${new URL(parsed.authorization_endpoint).pathname} and token endpoint ${new URL(parsed.token_endpoint).pathname}.`,
    });
    // Endpoints must stay on the authorization server we vetted: the token endpoint receives the client secret.
    const sameOrigin = (x) => { const v = safeUrl(x, { allowLocal }); return !!v && v.origin === asUrl.origin; };
    const okMeta = !!as.parsed && sameOrigin(as.parsed.authorization_endpoint) && sameOrigin(as.parsed.token_endpoint);
    d.asMeta = okMeta ? as.parsed : null;
    req.session.discovered = okMeta;
    res.json({ ok: okMeta });
  });

  // Step 2: authorization code + PKCE
  app.get('/auth/login', async (req, res) => {
    const { asMeta, prMeta } = disc(req);
    if (!asMeta) return res.status(409).send('Run discovery first.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    // Okta requires the same redirect_uri at /authorize and /token, so remember exactly what we sent.
    req.session.pkce = { verifier, state, redirectUri: req.tenant.redirectUri };
    F(req).pkce = { verifier, challenge, method: 'S256', state, resource: req.tenant.gatewayUrl, redirectUri: req.tenant.redirectUri };
    const scope = (prMeta?.scopes_supported || ['openid']).join(' ');
    const u = new URL(asMeta.authorization_endpoint);
    Object.entries({ client_id: req.tenant.clientId, response_type: 'code', redirect_uri: req.tenant.redirectUri, scope, state, code_challenge: challenge, code_challenge_method: 'S256', resource: req.tenant.gatewayUrl })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    // login_hint pre-fills the persona's username; prompt=login forces a fresh sign-in so the previous persona's Okta session is not reused.
    if (req.tenant.persona) { u.searchParams.set('login_hint', req.tenant.persona.login); u.searchParams.set('prompt', 'login'); }
    await emit(req.sessionID, {
      step: 'login', node: 'pkce', label: 'Send the user to Okta to sign in', method: 'GET (browser redirect)', url: u.toString().replace(/code_challenge=[^&]+/, 'code_challenge=' + mask(challenge)),
      request: { headers: {}, body: { response_type: 'code', scope, code_challenge_method: 'S256', code_challenge: mask(challenge), state: mask(state), resource: req.tenant.gatewayUrl } },
      response: null, ms: 0, outcome: 'ok',
      narration: `The app generated a random PKCE secret and sent only its SHA-256 hash (the challenge) to Okta. Anyone who intercepts the redirect cannot redeem the code without the original secret. The resource parameter pins the resulting token to this specific gateway, and scopes are ${scope}.`,
    });
    res.redirect(u.toString());
  });

  // "Try another team's agent": the signed-in persona asks Okta to sign them in to a DIFFERENT persona's agent. Nothing from the
  // result is ever exchanged or kept, so the persona's own session is untouched. Okta's answer is the evidence.
  const otherAgents = new Map(); // persona key -> what we learned about that agent's gateway and authorization server
  async function lookupAgent(req, p) {
    if (otherAgents.has(p.key)) return otherAgents.get(p.key);
    const gw = new URL(p.gatewayUrl);
    const prUrl = `${gw.origin}/.well-known/oauth-protected-resource${gw.pathname}`;
    if (!safeUrl(prUrl, { allowLocal })) return null;
    const pr = await traced({ sid: req.sessionID, step: 'login', label: `Look up the ${p.agent}’s gateway`, url: prUrl,
      narrate: ({ ev, parsed }) => ev.error ? `Lookup failed: ${ev.error}.` : ev.response.status !== 200 ? `Returned ${ev.response.status}.` : `The ${p.gatewayLabel} gateway names its own authorization server, ${parsed.authorization_servers?.[0]}. Each team’s gateway has a separate one.` });
    const asBase = pr.parsed?.authorization_servers?.[0];
    const asUrl = asBase && safeUrl(asBase, { allowLocal });
    if (!asUrl || (!allowLocal && asUrl.origin !== new URL(req.tenant.orgUrl).origin)) return null;
    const as = await traced({ sid: req.sessionID, step: 'login', label: `Look up the ${p.agent}’s authorization server`, url: `${asBase}/.well-known/oauth-authorization-server`,
      narrate: ({ ev, parsed }) => ev.error ? `Lookup failed: ${ev.error}.` : ev.response.status !== 200 ? `Returned ${ev.response.status}.` : `Its sign-in endpoint is ${new URL(parsed.authorization_endpoint).pathname}.` });
    const ep = as.parsed?.authorization_endpoint;
    const epUrl = ep && safeUrl(ep, { allowLocal });
    if (!epUrl || epUrl.origin !== asUrl.origin) return null;
    const found = { authorizeUrl: ep, scopes: (pr.parsed.scopes_supported || ['openid']).join(' ') };
    otherAgents.set(p.key, found);
    return found;
  }
  app.get('/auth/probe/:key', async (req, res) => {
    const me = req.tenant.persona, other = personaMap.get(req.params.key);
    if (!me || !req.session.tokens || !other?.configured || other.key === me.key) return res.status(400).send('Sign in as a persona first, and pick a different team’s agent.');
    const found = await lookupAgent(req, other);
    if (!found) return res.status(502).send('Could not look up that agent’s sign-in details.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `${req.tenant.origin}${other.callbackPath}`;
    req.session.pkce = { verifier, state, redirectUri, probe: other.key };
    const u = new URL(found.authorizeUrl);
    Object.entries({ client_id: other.clientId, response_type: 'code', redirect_uri: redirectUri, scope: found.scopes, state, code_challenge: challenge, code_challenge_method: 'S256', resource: other.gatewayUrl })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    await emit(req.sessionID, {
      step: 'login', label: `${me.name} tries to sign in to the ${other.agent}`, method: 'GET (browser redirect)', url: u.toString().replace(/code_challenge=[^&]+/, 'code_challenge=' + mask(challenge)),
      request: { headers: {}, body: { client_id: other.clientId, resource: other.gatewayUrl, note: 'No login hint and no forced login: Okta already knows who this is.' } }, response: null, ms: 0, outcome: 'ok',
      narration: `${me.name} is signed in as a ${me.department} user. This asks Okta to sign the same person in to the ${other.agent}, which belongs to a different team. Okta checks whether the ${other.agent}’s app is assigned to ${me.name}. Nothing from the answer is kept or exchanged.`,
    });
    res.redirect(u.toString());
  });

  app.get(CALLBACK_PATHS, async (req, res) => {
    const { code, state, error, error_description } = req.query;
    req.session.returnedFromOkta = true; // success or failure, the page that loads next is the return from Okta
    req.session.discovered = true;
    const saved = req.session.pkce;
    const { asMeta } = disc(req);
    const probed = saved?.probe ? personaMap.get(saved.probe) : null;
    if (error && probed) {
      req.session.pkce = null;
      await emit(req.sessionID, { step: 'login', label: `Okta refused ${req.tenant.persona?.name} access to the ${probed.agent}`, method: 'GET', url: redactUrl(req.originalUrl), request: { headers: {} }, response: { status: 400, body: { error, error_description } }, ms: 0, outcome: 'denied', verdict: probeVerdict({ person: req.tenant.persona?.name, agent: probed.agent, refused: true, target: { agent: probed.agent, gateway: probed.gatewayLabel, resource: probed.resourceLabel } }),
        narration: `Okta turned the sign-in away before issuing anything: ${error}${error_description ? ` (“${error_description}”)` : ''}. ${req.tenant.persona?.name} is not assigned to the ${probed.agent}, so they cannot use another team’s agent, whatever that agent’s gateway holds. This is the first line of defence.` });
      return res.redirect('/');
    }
    if (error) {
      await emit(req.sessionID, { step: 'login', label: 'Okta returned an error', method: 'GET', url: redactUrl(req.originalUrl), request: { headers: {} }, response: { status: 400, body: { error, error_description } }, ms: 0, outcome: 'denied', narration: `Okta refused the sign-in: ${error}${error_description ? ` — ${error_description}` : ''}. Nothing was issued.` });
      return res.redirect('/');
    }
    const stateOk = !!saved && typeof state === 'string' && state.length === saved.state.length
      && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state));
    if (!stateOk) {
      await emit(req.sessionID, { step: 'login', label: 'State mismatch', method: 'GET', url: redactUrl(req.originalUrl), request: { headers: {} }, response: { status: 400 }, ms: 0, outcome: 'denied', narration: 'The state value that came back did not match the one we sent. This is the CSRF check, so the response was discarded.' });
      return res.redirect('/');
    }
    if (saved.probe) {
      req.session.pkce = null;
      await emit(req.sessionID, { step: 'login', label: `Okta issued a code for the ${probed?.agent || 'other agent'}`, method: 'GET', url: redactUrl(req.originalUrl), request: { headers: {} }, response: { status: 200, body: { code: mask(code) } }, ms: 0, outcome: 'error', verdict: probeVerdict({ person: req.tenant.persona?.name, agent: probed?.agent || 'other agent', refused: false }),
        narration: `Unexpected: Okta let ${req.tenant.persona?.name} sign in to another team’s agent. The code was discarded. Check who the ${probed?.agent || 'other agent'}’s app is assigned to.` });
      return res.redirect('/');
    }
    F(req).code = code;
    await emit(req.sessionID, {
      step: 'login', node: 'code', label: 'Okta sent the user back with an authorization code', method: 'GET (browser redirect)', url: `${req.tenant.origin}${req.path}`,
      request: { headers: {}, body: { code: mask(code), state: mask(state) } }, response: null, ms: 0, outcome: 'ok',
      narration: 'The user signed in and Okta redirected the browser back with a one-time authorization code. The code is useless on its own: it can only be redeemed together with the PKCE secret that only this app holds, and only once.',
    });
    const { res: r, parsed } = await traced({
      sid: req.sessionID, step: 'login', node: 'access', label: 'Trade the authorization code for an access token', method: 'POST', url: asMeta.token_endpoint,
      form: { grant_type: 'authorization_code', code, redirect_uri: saved.redirectUri, client_id: req.tenant.clientId, ...(req.tenant.clientSecret ? { client_secret: req.tenant.clientSecret } : {}), code_verifier: saved.verifier },
      narrate: ({ ev, parsed }) => {
        if (ev.error) return `Token endpoint unreachable: ${ev.error}.`;
        if (ev.response.status !== 200) return `Okta rejected the code exchange (${parsed?.error || ev.response.status}${parsed?.error_description ? ': ' + parsed.error_description : ''}).`;
        const d = decodeJwt(parsed.access_token);
        const c = d?.claims || {};
        const mins = Math.round((parsed.expires_in || 0) / 60);
        return `Okta verified the PKCE secret and issued an access token for ${c.sub || 'the user'}. Its audience is ${c.aud}, so it only works at this gateway. It expires in ${mins} minutes${parsed.refresh_token ? '' : ' and no refresh token was issued, so the user must sign in again afterwards'}.`;
      },
    });
    if (r?.status === 200) req.session.tokens = { ...parsed, obtained_at: Date.now() };
    else F(req).tokenError = { status: r?.status ?? null, ...(parsed || {}) };
    req.session.pkce = null;
    res.redirect('/');
  });

  app.post('/api/logout', async (req, res) => {
    await resetAuth(req);
    await store.clear(req.sessionID, { resetSeq: true });
    res.json({ ok: true });
  });

  // Step 3: MCP over the gateway
  let rpcId = 10;
  async function mcp(req, method, params, label, narrate, node = 'gateway', opts = {}) {
    const t = req.session.tokens;
    if (!t) return { status: 401, body: { error: 'Not signed in' } };
    const headers = { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
    if (req.session.mcpSessionId) headers['Mcp-Session-Id'] = req.session.mcpSessionId;
    const body = method.startsWith('notifications/') ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params };
    const startedAt = Date.now();
    const r = await traced({ sid: req.sessionID, step: 'mcp', node, label, method: 'POST', url: req.tenant.gatewayUrl, headers, body, narrate, outcomeOf: opts.outcomeOf, verdictOf: opts.verdictOf });
    const sid = r.resHeaders['mcp-session-id'];
    if (sid) req.session.mcpSessionId = sid;
    if (!method.startsWith('notifications/')) {
      const status = r.res?.status ?? 0, pb = r.parsed;
      const consentUrl = findConsentUrl(pb);
      const rec = { at: startedAt, mcp: method, tool: params?.name, status, ms: r.ev.ms, rpcError: pb?.error?.message || null, consentUrl,
        toolCount: pb?.result?.tools?.length, ok: status === 200 && !pb?.error && !pb?.result?.isError, mcpSessionId: sid || req.session.mcpSessionId || null,
        authorization: redactHeaders({ authorization: headers.Authorization }).authorization };
      if (opts.blocked) rec.blocked = true;
      if (method === 'tools/list' && Array.isArray(pb?.result?.tools)) req.session.exposedTools = pb.result.tools.map((t) => t.name);
      F(req).gateway.calls.push(rec);
      if (method === 'tools/call') F(req).toolCalls.push(rec);
      if (method === 'tools/call' && status === 200 && !opts.blocked && !consentUrl) defer(collectSts(req, startedAt, params?.name)); // runs after the response: the log lags a couple of seconds
    }
    return { status: r.res?.status ?? 502, body: r.parsed, error: r.ev.error };
  }

  app.post('/api/mcp/initialize', async (req, res) => {
    const r = await mcp(req, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-gateway-demo', version: '1.0.0' } }, 'Open an MCP session through the gateway',
      ({ ev, parsed, resHeaders }) => {
        if (ev.error) return `Gateway unreachable: ${ev.error}.`;
        const s = ev.response.status;
        if (s === 401) return 'The gateway rejected our access token (401). It is expired, was issued for a different audience, or the virtual MCP server is not active.';
        if (s === 403) return 'The gateway understood the token but refused access (403). Check the delegation link between this agent and the virtual MCP server.';
        if (s >= 300) return `Gateway returned ${s}: ${JSON.stringify(parsed).slice(0, 200)}`;
        const info = parsed?.result?.serverInfo;
        return `The gateway accepted our Okta token and answered as MCP server “${info?.name || 'unknown'}”${info?.version ? ' v' + info.version : ''}. It advertises capabilities: ${Object.keys(parsed?.result?.capabilities || {}).join(', ') || 'none'}. ${resHeaders['mcp-session-id'] ? 'It also issued an MCP session ID.' : 'Note: stateless, no session ID issued.'}`;
      });
    if (r.status < 300) await mcp(req, 'notifications/initialized', {}, 'Tell the gateway we are ready', ({ ev }) => `Handshake complete (HTTP ${ev.response?.status}). The client can now ask what tools are available.`);
    res.status(r.status).json(r.body);
  });

  app.post('/api/mcp/tools', async (req, res) => {
    const r = await mcp(req, 'tools/list', {}, 'Ask the gateway which tools this agent may use',
      ({ ev, parsed }) => {
        if (ev.error) return `Gateway unreachable: ${ev.error}.`;
        if (ev.response.status !== 200) return `tools/list failed with ${ev.response.status}: ${JSON.stringify(parsed).slice(0, 220)}`;
        if (parsed?.error) {
          const url = findConsentUrl(parsed);
          return url ? 'The gateway could not get a GitHub token for this user yet. Okta needs the user to consent to GitHub access once; a consent link was returned.'
            : `The gateway returned an MCP error: ${parsed.error.message}.`;
        }
        const tools = parsed?.result?.tools || [];
        return `The gateway returned ${tools.length} tool${tools.length === 1 ? '' : 's'} (${tools.slice(0, 5).map((x) => x.name).join(', ')}${tools.length > 5 ? ', …' : ''}). These are the tools the admin chose to expose from the upstream server, not everything GitHub offers. The gateway validated our token to answer this. No GitHub token is involved yet: Okta’s log shows the token exchange with GitHub happening when a tool is actually called.`;
      });
    res.status(r.status).json({ ...r.body, consentUrl: findConsentUrl(r.body) });
  });

  app.post('/api/mcp/call', async (req, res) => {
    const { name, arguments: args } = req.body;
    const r = await mcp(req, 'tools/call', { name, arguments: args || {} }, `Call tool “${name}”`,
      ({ ev, parsed }) => {
        if (ev.error) return `Gateway unreachable: ${ev.error}.`;
        if (ev.response.status !== 200) return `tools/call failed with ${ev.response.status}: ${JSON.stringify(parsed).slice(0, 220)}`;
        if (findConsentUrl(parsed)) return 'The gateway could not call the downstream service yet: Okta needs this user to consent once, and returned a link. Open it, approve, then run the tool again. Okta stores the result, so this is a one-time step per user.';
        if (parsed?.error) return `MCP error ${parsed.error.code}: ${parsed.error.message}.`;
        const isErr = parsed?.result?.isError;
        return `The gateway forwarded ${name} to the downstream service using a token the agent never saw, and relayed the result${isErr ? ' (the service reported a tool-level error)' : ''}. ${ev.ms} ms round trip including the token exchange.`;
      }, 'toolcall', {
        verdictOf: ({ ev, parsed }) => callVerdict({ name, status: ev.response?.status, error: ev.error, parsed, consentUrl: findConsentUrl(parsed) }),
        // Needing consent or being refused is amber, a real failure is red, and only a normal result is green.
        outcomeOf: ({ ev, parsed }) => ({ consent: 'denied', waking: 'denied', 'blocked-server': 'denied', problem: 'error' }[callVerdict({ name, status: ev.response?.status, error: ev.error, parsed, consentUrl: findConsentUrl(parsed) }).kind] || (ev.response.status < 300 ? 'ok' : 'error')),
      });
    res.status(r.status).json({ ...r.body, consentUrl: findConsentUrl(r.body) });
  });

  // Governance check: ask the gateway for a real tool its admin did not expose (another team's tool, or a GitHub write).
  // Only the names listed for personas are allowed, and the call is refused unless the gateway's own tools/list (remembered from this
  // session) shows the tool is NOT exposed, so this can never run anything. Arguments are empty on purpose.
  const blockable = new Set(['GitHubMCP_merge_pull_request', 'GitHubMCP_delete_file', ...(config.personas || []).flatMap((p) => p.blockedTools.map((t) => t.name))]);
  app.post('/api/mcp/blocked', async (req, res) => {
    const name = req.body?.tool;
    if (!blockable.has(name)) return res.status(400).json({ error: 'Unknown governance check' });
    const exposed = req.session.exposedTools;
    if (!exposed) return res.status(409).json({ error: 'List the gateway’s tools first.' });
    if (exposed.includes(name)) return res.status(409).json({ error: `${name} is exposed on this gateway, so it is not a valid denial test.` });
    const startedAt = Date.now();
    const refused = (parsed) => !!(parsed?.error || parsed?.result?.isError);
    const r = await mcp(req, 'tools/call', { name, arguments: {} }, `Call “${name}”, which the admin did not expose`,
      ({ ev, parsed }) => {
        if (ev.error) return `Gateway unreachable: ${ev.error}.`;
        const s = ev.response.status;
        const text = parsed?.error?.message || (parsed?.result?.content || []).map((c) => c.text).filter(Boolean).join(' ') || (typeof parsed === 'string' ? parsed : '');
        const list = `${name} is not among the ${exposed.length} tool${exposed.length === 1 ? '' : 's'} the gateway listed for this agent`;
        if (s >= 400) return `The gateway refused the call outright (HTTP ${s}${text ? `: ${String(text).slice(0, 160)}` : ''}). ${list}. The next card shows what Okta’s own log recorded.`;
        if (refused(parsed)) return `The gateway did not run it. It answered${parsed?.error ? ` with MCP error ${parsed.error.code}${parsed.error.message ? ` (“${String(parsed.error.message).slice(0, 80)}”)` : ''}` : text ? `: ${String(text).slice(0, 160)}` : ''}. ${list}. The next card shows what Okta’s own log recorded, including why.`;
        return `Unexpected: the gateway did not refuse ${name}. Check which tools are exposed on the virtual MCP server.`;
      }, 'gateway', { blocked: true, verdictOf: ({ ev, parsed }) => blockedVerdict({ name, gatewayLabel: req.tenant.persona?.gatewayLabel, refused: ev.response.status >= 400 || refused(parsed) }), outcomeOf: ({ ev, parsed }) => (ev.response.status >= 400 || refused(parsed) ? 'denied' : 'error') });
    console.log(`[blocked-call] ${name} -> HTTP ${r.status} ${JSON.stringify(r.body?.error || r.body?.result?.content || r.body || '').slice(0, 300)}`);
    if (r.status < 500) defer(collectBlocked(req, startedAt, name));
    res.status(r.status).json({ ...r.body, tool: name });
  });

  // ---------- token flow (DAG) ----------
  // The downstream GitHub token is minted and held inside Okta, so nobody outside it can see it. What we can show
  // is Okta's own System Log record of the exchange. This uses the admin token from the shell the server was started in
  // (or an OKTA_API_TOKEN line in your local, gitignored .env); without it the STS stage simply has no log evidence.

  async function collectSts(req, sinceMs, tool) {
    if (!req.tenant.logToken) return;
    const sid = req.sessionID;
    // Okta's log is org-wide, so only accept exchanges that name this session's user. Fail closed: with no identity, no evidence.
    const idc = req.session.tokens?.id_token ? decodeJwt(req.session.tokens.id_token)?.claims : null;
    const ac = decodeJwt(req.session.tokens?.access_token)?.claims;
    const mine = (e) => isMine(e, ac, idc);
    const hdr = { Authorization: `SSWS ${req.tenant.logToken}`, Accept: 'application/json' };
    const q = (extra) => `${req.tenant.orgUrl}/api/v1/logs?${new URLSearchParams({ limit: '100', ...extra })}`;
    const get = async (url) => {
      const j = await fetch(url, { headers: hdr, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
      if (!Array.isArray(j)) throw new Error(j?.errorSummary || 'unexpected System Log response');
      return j.map(summarizeLog);
    };
    const started = Date.now();
    try {
      // The System Log lags a little, so poll until Okta has recorded the gateway's own tool.call event for this request.
      let win = [];
      for (let i = 0; i < 4; i++) {
        await sleep(i === 0 ? 2500 : 2000);
        win = await get(q({ since: new Date(sinceMs - 5000).toISOString(), sortOrder: 'ASCENDING', filter: `eventType sw "${STS_EVENT}" or eventType sw "agent_gateway.mcp"` }));
        if (win.some((e) => e.eventType === 'agent_gateway.mcp.tool.call')) break;
      }
      const exchange = [...win].reverse().find((e) => e.eventType === STS_EVENT && mine(e)) || null;
      // No fresh exchange means the gateway may have reused a downstream token it already held; find the latest one for this agent.
      const latest = exchange ? null : (await get(q({ since: new Date(Date.now() - 864e5).toISOString(), sortOrder: 'DESCENDING', limit: '20', filter: `eventType sw "${STS_EVENT}"` }))).find((e) => e.subjectTokenClientId === req.tenant.clientId && mine(e)) || null;
      const consent = (await get(q({ since: new Date(Date.now() - 7 * 864e5).toISOString(), sortOrder: 'DESCENDING', limit: '20', filter: 'eventType eq "app.oauth2.token.oauth_sts.request_token"' }))).find(mine) || null;
      await store.put('sts:' + sid, { exchange, latest, reused: !exchange && !!latest, consent, window: win, checkedAt: new Date().toISOString(), tool });
      const t = (iso) => new Date(iso).toLocaleTimeString();
      const gw = win.filter((e) => e.eventType.startsWith('agent_gateway.'));
      const consentLine = consent ? ` No consent prompt was needed: you had already authorized GitHub at ${t(consent.at)} and Okta stored the token pair (${consent.persistedTokenTypes || 'access + refresh'}). Okta’s log doesn’t say outright that it was reused, so that part is inferred.` : '';
      let narration;
      if (exchange) {
        narration = `Okta’s System Log confirms the exchange at ${t(exchange.at)} (${exchange.result}). The gateway, signing in as its own workload identity (${exchange.clientAuthType}), presented the agent’s access token. Okta checked delegation link ${exchange.delegationLinkId} and resource connection ${exchange.resourceConnectionId}, then returned a GitHub ${exchange.returnedTokenTypes} in ${exchange.responseTimeMs} ms.${consentLine} This app never sees that GitHub token.`;
      } else if (latest) {
        narration = `Okta’s log shows no new token exchange for this call, which suggests the gateway reused a downstream token it already held. The most recent exchange for this agent was at ${t(latest.at)} (${latest.result}).${consentLine}`;
      } else {
        narration = `The call succeeded, so the gateway must have used a GitHub token, but Okta’s log shows no token exchange for this agent in the last 24 hours. The log can lag; this stays “inferred” until a record appears.`;
      }
      await emit(sid, {
        step: 'mcp', node: 'sts', label: 'Okta System Log: the token exchange behind that call', method: 'GET', url: `${req.tenant.orgUrl}/api/v1/logs`,
        request: { headers: redactHeaders(hdr), body: { since: new Date(sinceMs - 5000).toISOString(), filter: 'token exchange + agent_gateway events' } },
        response: { status: 200, body: { exchange, mostRecentExchange: latest, gatewayEvents: gw, githubConsentOnFile: consent } },
        ms: Date.now() - started, outcome: exchange && exchange.result !== 'SUCCESS' ? 'error' : 'ok', narration,
        evidence: exchange ? `Okta’s log: token exchange ${exchange.result}${exchange.responseTimeMs ? ` in ${exchange.responseTimeMs} ms` : ''}` : latest ? 'Okta’s log: an earlier downstream token was reused' : undefined,
      });
    } catch (e) {
      await emit(sid, { step: 'mcp', node: 'sts', label: 'Okta System Log lookup failed', method: 'GET', url: `${req.tenant.orgUrl}/api/v1/logs`, request: { headers: redactHeaders(hdr) }, response: null, ms: Date.now() - started, error: String(e.message || e), outcome: 'error', narration: `Could not read Okta’s System Log: ${e.message}. The exchange still happened; only the evidence is missing.` });
    }
  }

  // What Okta's own log says about a denied call: did it reach the token exchange? Reports facts only.
  async function collectBlocked(req, sinceMs, tool) {
    if (!req.tenant.logToken) return;
    const sid = req.sessionID;
    const idc = req.session.tokens?.id_token ? decodeJwt(req.session.tokens.id_token)?.claims : null;
    const ac = decodeJwt(req.session.tokens?.access_token)?.claims;
    const hdr = { Authorization: `SSWS ${req.tenant.logToken}`, Accept: 'application/json' };
    const q = `${req.tenant.orgUrl}/api/v1/logs?${new URLSearchParams({ limit: '50', since: new Date(sinceMs - 3000).toISOString(), sortOrder: 'ASCENDING', filter: `eventType sw "${STS_EVENT}" or eventType sw "agent_gateway.mcp"` })}`;
    const started = Date.now();
    try {
      let win = [];
      // Denied calls reach the log more slowly than successful ones (around 15 s was seen), so wait longer.
      for (let i = 0; i < 8; i++) {
        await sleep(i === 0 ? 3000 : 3000);
        const j = await fetch(q, { headers: hdr, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
        if (!Array.isArray(j)) throw new Error(j?.errorSummary || 'unexpected System Log response');
        win = j.map(summarizeLog);
        if (win.some((e) => e.eventType === 'agent_gateway.mcp.tool.call' && String(e.reason || '').includes(tool))) break;
      }
      const gw = win.filter((e) => e.eventType.startsWith('agent_gateway.'));
      const calls = gw.filter((e) => e.eventType === 'agent_gateway.mcp.tool.call' && String(e.reason || '').includes(tool));
      const exchanges = win.filter((e) => e.eventType === STS_EVENT && isMine(e, ac, idc));
      const t = (iso) => new Date(iso).toLocaleTimeString();
      const last = calls[calls.length - 1];
      const callLine = last ? `Okta’s own log recorded the gateway’s tool.call event at ${t(last.at)} with result ${last.result}${last.reason ? `, reason: ${last.reason}` : ''}.` : 'Okta’s log has not yet shown a tool.call event for this attempt (denied calls can take 15 seconds or more to appear).';
      const stsLine = exchanges.length ? `It also shows ${exchanges.length} token exchange${exchanges.length === 1 ? '' : 's'} for you in that window, so Okta did go to the token exchange.` : (last ? 'It shows no token exchange for you in that window, so the gateway stopped the call before any GitHub token was requested.' : 'It shows no token exchange for you in that window so far.');
      await emit(sid, {
        step: 'mcp', node: 'gateway', label: 'Okta System Log: what Okta recorded for the blocked call', method: 'GET', url: `${req.tenant.orgUrl}/api/v1/logs`,
        request: { headers: redactHeaders(hdr), body: { since: new Date(sinceMs - 3000).toISOString(), filter: 'token exchange + agent_gateway events', tool } },
        response: { status: 200, body: { gatewayEvents: gw, tokenExchangesForThisUser: exchanges } },
        ms: Date.now() - started, outcome: 'ok', narration: `${callLine} ${stsLine}`,
        evidence: last ? `Okta’s log: ${last.result}${last.reason ? ` (${last.reason})` : ''}${exchanges.length ? '' : '; no token exchange'}` : undefined,
      });
    } catch (e) {
      await emit(sid, { step: 'mcp', node: 'gateway', label: 'Okta System Log lookup failed', method: 'GET', url: `${req.tenant.orgUrl}/api/v1/logs`, request: { headers: redactHeaders(hdr) }, response: null, ms: Date.now() - started, error: String(e.message || e), outcome: 'error', narration: `Could not read Okta’s System Log: ${e.message}.` });
    }
  }

  app.get('/api/flow', async (req, res) => {
    const s = req.session, fl = s.flow || {}, t = s.tokens, g = fl.gateway?.calls || [], last = g[g.length - 1];
    const gOk = g.some((c) => c.status === 200 && !c.rpcError);
    const callOk = (fl.toolCalls || []).some((c) => c.ok);
    const consentUrl = last?.consentUrl || null;
    const ev = await store.take('sts:' + req.sessionID);
    const stsS = stsStatus({ sts: ev, consentUrl, callOk });
    const ghRec = ev?.exchange || ev?.latest || null;
    const dec = t ? decodeJwt(t.access_token) : null, idDec = t?.id_token ? decodeJwt(t.id_token) : null;
    const pk = fl.pkce;
    const { asMeta, prMeta } = disc(req);
    const nodes = {
      discover: { status: s.discovered && asMeta ? 'done' : 'idle', data: asMeta ? {
        resource: prMeta?.resource, scopes_supported: prMeta?.scopes_supported, authorization_server: asMeta.issuer,
        authorization_endpoint: asMeta.authorization_endpoint, token_endpoint: asMeta.token_endpoint,
        code_challenge_methods_supported: asMeta.code_challenge_methods_supported } : null },
      pkce: { status: pk ? 'done' : 'idle', data: pk ? { code_verifier: fl.code ? pk.verifier : mask(pk.verifier), verifier_note: fl.code ? 'Redeemed, so it is now worthless. It is shown in full because the proof is spent.' : 'Secret: only the hash below ever leaves the app.', code_challenge: pk.challenge, code_challenge_method: pk.method, state: pk.state, resource: pk.resource } : null },
      code: { status: fl.code ? 'done' : 'idle', data: fl.code ? { authorization_code: fl.code, single_use: true, redirect_uri: pk?.redirectUri || req.tenant.redirectUri } : null },
      access: { status: t ? 'done' : fl.tokenError ? 'error' : 'idle', data: t ? { access_token: t.access_token, token_type: t.token_type, scope: t.scope, expires_in: t.expires_in, refresh_token: t.refresh_token ? mask(t.refresh_token) : 'none issued', header: dec?.header, claims: dec?.claims, expiresAt: t.obtained_at + (t.expires_in || 0) * 1000 } : fl.tokenError || null },
      idtoken: { status: idDec ? 'done' : t ? 'skipped' : 'idle', data: idDec ? { id_token: t.id_token, header: idDec.header, claims: idDec.claims } : null },
      gateway: { status: !g.length ? 'idle' : last?.blocked ? 'error' : gOk ? 'done' : 'error', data: g.length ? { calls: g.slice(-8), audience_matches_gateway: dec?.claims?.aud === req.tenant.gatewayUrl, token_audience: dec?.claims?.aud, gateway: req.tenant.gatewayUrl } : null },
      sts: { status: stsS, data: stsS !== 'idle' ? { consentUrl, logAvailable: !!req.tenant.logToken, checkedAt: ev?.checkedAt, exchange: ev?.exchange || null, reused: !!ev?.reused, lastExchange: ev?.latest || null, consentOnFile: ev?.consent || null, oktaGatewayEvents: (ev?.window || []).filter((e) => e.eventType.startsWith('agent_gateway.')) } : null },
      ghtoken: { status: stsS === 'waiting' ? 'idle' : stsS, data: stsS !== 'idle' && stsS !== 'waiting' ? { visible: false, held_by: 'Okta. Never sent to this app or to the agent.', reused: !!ev?.reused, returned: ghRec ? { tokenTypes: ghRec.returnedTokenTypes, at: ghRec.at, responseTimeMs: ghRec.responseTimeMs, targetResourceOrn: ghRec.targetResourceOrn } : null, consentOnFile: ev?.consent ? { at: ev.consent.at, persistedTokenTypes: ev.consent.persistedTokenTypes } : null } : null },
      toolcall: { status: callOk ? 'done' : consentUrl ? 'waiting' : (fl.toolCalls || []).length ? 'error' : 'idle', data: (fl.toolCalls || []).length ? { calls: fl.toolCalls.slice(-6) } : null },
    };
    // The latest call was turned away at the gateway, so it never reached the token exchange, the GitHub token or the tool.
    if (last?.blocked) for (const id of ['sts', 'ghtoken', 'toolcall']) nodes[id] = { status: 'idle', data: null };
    res.json({ nodes });
  });

  // Never leak internals: log server-side, answer generically.
  app.use((err, _req, res, _next) => {
    console.error('request failed:', err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}

// Run as a server only when executed directly (npm start), not when imported by tests or by the Vercel function.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dotenv.config();
  try {
    const config = configFromEnv(process.env, { redisFactory: (o) => new Redis(o) });
    const origin = config.origin;
    createApp(config).listen(config.port, () => console.log(`Agent Gateway demo listening on port ${config.port}, public address ${origin || `http://localhost:${config.port}`}`));
  } catch (e) { console.error(e.message); process.exit(1); }
}
