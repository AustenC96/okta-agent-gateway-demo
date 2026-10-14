import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tenantNameFrom } from './tenant.js';

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
    actor: e.actor?.alternateId && e.actor.alternateId !== 'unknown' ? e.actor.alternateId : e.actor?.id, actorType: e.actor?.type,
    message: e.displayMessage || undefined,
    tokenExchangeType: d.tokenExchangeType, clientAuthType: d.clientAuthType, subjectTokenClientId: d.subjectTokenClientId,
    subjectTokenIssuer: d.subjectTokenIssuer, delegationLinkId: d.delegationLinkId, resourceConnectionId: d.resourceConnectionId,
    responseTimeMs: d.responseTime ? Number(d.responseTime) : undefined, returnedTokenTypes: d.returnedTokenTypes,
    targetResourceOrn: d.targetResourceOrn, persistedTokenTypes: d.persistedTokenTypes, grantType: d.grantType,
  };
};

// Status of the two stages that happen inside Okta, from what Okta’s log said (pure, so it can be tested).
export function stsStatus({ sts, consentUrl, callOk }) {
  if (consentUrl) return 'waiting';
  if (sts?.exchange) return sts.exchange.result === 'SUCCESS' ? 'done' : 'error';
  if (sts?.reused) return 'done';
  return callOk ? 'inferred' : 'idle';
}

// Builds one self-contained app. All mutable state (trace, discovery results, STS evidence) lives inside this closure,
// so each call gets its own state and nothing leaks between instances.
export function createApp(config) {
  const resolution = config.resolution || { strategy: 'none' };
  // A tenant is one demo's settings. With no getTenant, the one configured tenant is served as 'default'.
  const staticTenant = config.gatewayUrl && { name: 'default', orgUrl: config.orgUrl, gatewayUrl: config.gatewayUrl, clientId: config.clientId, clientSecret: config.clientSecret, logToken: config.logToken, origin: config.origin };
  const rawTenant = config.getTenant || (async (name) => (name === 'default' ? staticTenant : null));
  const getTenant = async (name) => {
    const t = await rawTenant(name);
    if (!t) return null;
    const origin = t.origin || config.origin || `http://localhost:${config.port}`;
    const gw = new URL(t.gatewayUrl);
    return { ...t, name, origin, redirectUri: `${origin}/authorization-code/callback`, gatewayOrigin: gw.origin, gatewayPath: gw.pathname };
  };

  // ---------- event log (every real HTTP call lands here) ----------
  // One bucket per browser session, so a visitor only ever sees their own calls.
  const buckets = new Map();
  const bucket = (sid) => {
    let b = buckets.get(sid);
    if (!b) buckets.set(sid, b = { events: [], listeners: new Set(), seq: 0, lastSeen: Date.now() });
    b.lastSeen = Date.now();
    return b;
  };
  function emit(sid, ev) {
    const b = bucket(sid);
    ev.id = ++b.seq;
    ev.ts = new Date().toISOString();
    b.events.push(ev);
    if (b.events.length > 500) b.events.shift();
    for (const res of b.listeners) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    return ev;
  }
  // Drop buckets nobody has touched for an hour and that have no open stream.
  setInterval(() => {
    for (const [sid, b] of buckets) if (!b.listeners.size && Date.now() - b.lastSeen > 3600e3) buckets.delete(sid);
  }, 600e3).unref();

  // A traced fetch: performs the real request and emits a structured event.
  async function traced({ sid, step, node, label, method = 'GET', url, headers = {}, body, form, narrate }) {
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
    ev.outcome = error ? 'error' : res.status < 300 ? 'ok' : res.status === 401 || res.status === 403 || res.status === 400 ? 'denied' : 'error';
    emit(sid, ev);
    return { res, parsed, resHeaders, ev };
  }

  // ---------- app ----------
  const app = express();
  app.use(express.json());
  app.use(session({ secret: crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: true, cookie: { sameSite: 'lax' } }));
  // Resolve which demo this request is for. The OAuth callback always uses the tenant the sign-in started under,
  // never anything in its own query string, and switching demos drops the previous demo's tokens.
  const resetAuth = (req) => {
    Object.assign(req.session, { tokens: null, mcpSessionId: null, pkce: null, discovered: false, returnedFromOkta: false, flow: null });
    stsEvidence.delete(req.sessionID);
  };
  app.use(async (req, res, next) => {
    try {
      let name;
      if (req.path === '/authorization-code/callback' && req.session.tenant) name = req.session.tenant;
      else {
        const r = tenantNameFrom(req, resolution);
        if (r.invalid) return res.status(400).json({ error: 'Invalid demo name' });
        name = r.name || (resolution.strategy === 'query' && req.session.tenant) || 'default';
      }
      const tenant = await getTenant(name);
      if (!tenant) return res.status(404).json({ error: 'Unknown demo' });
      if (req.session.tenant && req.session.tenant !== name) resetAuth(req);
      req.session.tenant = name;
      req.tenant = tenant;
      next();
    } catch (e) { next(e); }
  });
  app.use(express.static(path.join(__dirname, 'public')));

  // Okta System Log evidence arrives seconds after the HTTP response is sent, and express-session only saves at response time,
  // so anything written later would be lost. Keep it here, keyed by session id.
  const stsEvidence = new Map();
  const F = (req) => (req.session.flow ||= { gateway: { calls: [] }, toolCalls: [], sts: null, stsConsent: null });
  // Public metadata the gateway published, cached per tenant so one demo's discovery never answers for another's.
  const discovery = new Map();
  const disc = (req) => { let d = discovery.get(req.tenant.name); if (!d) discovery.set(req.tenant.name, d = {}); return d; };

  app.get('/api/config', (req, res) => {
    const t = req.session.tokens;
    res.json({
      gatewayUrl: req.tenant.gatewayUrl, orgUrl: req.tenant.orgUrl, clientId: req.tenant.clientId, redirectUri: req.tenant.redirectUri,
      discovered: !!req.session.discovered && !!disc(req).asMeta, signedIn: !!t, tokenInfo: t ? tokenInfo(t) : null, mcpSessionId: req.session.mcpSessionId || null,
    });
  });
  function tokenInfo(t) {
    const d = decodeJwt(t.access_token);
    return {
      claims: d?.claims || null, header: d?.header || null,
      expiresAt: t.obtained_at + (t.expires_in || 0) * 1000, scope: t.scope, hasRefresh: !!t.refresh_token,
      idClaims: t.id_token ? decodeJwt(t.id_token)?.claims : null,
    };
  }

  // live event stream (new events only; the feed starts empty on every page load)
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    // A fresh page load starts empty. The only exception is returning from the Okta redirect:
    // the client passes ?after=<last id it showed> so it receives just the calls it missed.
    const after = Number(req.query.after);
    const b = bucket(req.sessionID);
    if (Number.isFinite(after)) for (const ev of b.events) if (ev.id > after) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    b.listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); b.listeners.delete(res); });
  });
  // Called on every page load. Coming back from Okta keeps the walkthrough where it was (the callback set
  // returnedFromOkta); any other load, such as a manual refresh, restarts it at step 1.
  app.post('/api/page-load', (req, res) => {
    const returned = !!req.session.returnedFromOkta;
    req.session.returnedFromOkta = false;
    if (!returned) { req.session.discovered = false; req.session.flow = null; stsEvidence.delete(req.sessionID); }
    res.json({ returned });
  });
  app.post('/api/events/clear', (req, res) => { bucket(req.sessionID).events.length = 0; res.json({ ok: true }); });

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
    const pr = await traced({
      sid: req.sessionID, step: 'discover', node: 'discover', label: 'Read the gateway’s protected-resource metadata', url: prUrl,
      narrate: ({ ev, parsed }) => ev.error ? `Metadata fetch failed: ${ev.error}.` : ev.response.status !== 200 ? `Metadata endpoint returned ${ev.response.status}.`
        : `The gateway says it is the protected resource “${new URL(parsed.resource).pathname}” and that tokens must come from ${parsed.authorization_servers?.[0]}. Supported scopes: ${(parsed.scopes_supported || []).join(', ')}. The client now knows exactly who to ask for a token.`,
    });
    const d = disc(req);
    d.prMeta = pr.parsed;
    const asBase = d.prMeta?.authorization_servers?.[0];
    if (!asBase) return res.status(502).json({ error: 'No authorization server advertised by gateway' });
    const as = await traced({
      sid: req.sessionID, step: 'discover', node: 'discover', label: 'Read the authorization server’s metadata', url: `${asBase}/.well-known/oauth-authorization-server`,
      narrate: ({ ev, parsed }) => ev.error ? `Failed: ${ev.error}.` : ev.response.status !== 200 ? `Returned ${ev.response.status}.`
        : `This is a dedicated Okta custom authorization server created for the gateway. It supports ${(parsed.grant_types_supported || []).length} grant types and PKCE methods ${(parsed.code_challenge_methods_supported || []).join(', ')}. We will use the authorization endpoint ${new URL(parsed.authorization_endpoint).pathname} and token endpoint ${new URL(parsed.token_endpoint).pathname}.`,
    });
    d.asMeta = as.parsed;
    req.session.discovered = !!d.asMeta?.authorization_endpoint;
    res.json({ ok: !!d.asMeta?.authorization_endpoint });
  });

  // Step 2: authorization code + PKCE
  app.get('/auth/login', async (req, res) => {
    const { asMeta, prMeta } = disc(req);
    if (!asMeta) return res.status(409).send('Run discovery first.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.pkce = { verifier, state };
    F(req).pkce = { verifier, challenge, method: 'S256', state, resource: req.tenant.gatewayUrl };
    const scope = (prMeta?.scopes_supported || ['openid']).join(' ');
    const u = new URL(asMeta.authorization_endpoint);
    Object.entries({ client_id: req.tenant.clientId, response_type: 'code', redirect_uri: req.tenant.redirectUri, scope, state, code_challenge: challenge, code_challenge_method: 'S256', resource: req.tenant.gatewayUrl })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    emit(req.sessionID, {
      step: 'login', node: 'pkce', label: 'Send the user to Okta to sign in', method: 'GET (browser redirect)', url: u.toString().replace(/code_challenge=[^&]+/, 'code_challenge=' + mask(challenge)),
      request: { headers: {}, body: { response_type: 'code', scope, code_challenge_method: 'S256', code_challenge: mask(challenge), state: mask(state), resource: req.tenant.gatewayUrl } },
      response: null, ms: 0, outcome: 'ok',
      narration: `The app generated a random PKCE secret and sent only its SHA-256 hash (the challenge) to Okta. Anyone who intercepts the redirect cannot redeem the code without the original secret. The resource parameter pins the resulting token to this specific gateway, and scopes are ${scope}.`,
    });
    res.redirect(u.toString());
  });

  app.get('/authorization-code/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    req.session.returnedFromOkta = true; // success or failure, the page that loads next is the return from Okta
    req.session.discovered = true;
    const saved = req.session.pkce;
    const { asMeta } = disc(req);
    if (error) {
      emit(req.sessionID, { step: 'login', label: 'Okta returned an error', method: 'GET', url: req.originalUrl, request: { headers: {} }, response: { status: 400, body: { error, error_description } }, ms: 0, outcome: 'denied', narration: `Okta refused the sign-in: ${error}${error_description ? ` — ${error_description}` : ''}. Nothing was issued.` });
      return res.redirect('/');
    }
    if (!saved || state !== saved.state) {
      emit(req.sessionID, { step: 'login', label: 'State mismatch', method: 'GET', url: req.originalUrl, request: { headers: {} }, response: { status: 400 }, ms: 0, outcome: 'denied', narration: 'The state value that came back did not match the one we sent. This is the CSRF check, so the response was discarded.' });
      return res.redirect('/');
    }
    F(req).code = code;
    emit(req.sessionID, {
      step: 'login', node: 'code', label: 'Okta sent the user back with an authorization code', method: 'GET (browser redirect)', url: `${req.tenant.origin}/authorization-code/callback`,
      request: { headers: {}, body: { code: mask(code), state: mask(state) } }, response: null, ms: 0, outcome: 'ok',
      narration: 'The user signed in and Okta redirected the browser back with a one-time authorization code. The code is useless on its own: it can only be redeemed together with the PKCE secret that only this app holds, and only once.',
    });
    const { res: r, parsed } = await traced({
      sid: req.sessionID, step: 'login', node: 'access', label: 'Trade the authorization code for an access token', method: 'POST', url: asMeta.token_endpoint,
      form: { grant_type: 'authorization_code', code, redirect_uri: req.tenant.redirectUri, client_id: req.tenant.clientId, client_secret: req.tenant.clientSecret, code_verifier: saved.verifier },
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

  app.post('/api/logout', (req, res) => {
    resetAuth(req);
    const b = bucket(req.sessionID); b.events.length = 0; b.seq = 0;
    res.json({ ok: true });
  });

  // Step 3: MCP over the gateway
  let rpcId = 10;
  async function mcp(req, method, params, label, narrate, node = 'gateway') {
    const t = req.session.tokens;
    if (!t) return { status: 401, body: { error: 'Not signed in' } };
    const headers = { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
    if (req.session.mcpSessionId) headers['Mcp-Session-Id'] = req.session.mcpSessionId;
    const body = method.startsWith('notifications/') ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params };
    const startedAt = Date.now();
    const r = await traced({ sid: req.sessionID, step: 'mcp', node, label, method: 'POST', url: req.tenant.gatewayUrl, headers, body, narrate });
    const sid = r.resHeaders['mcp-session-id'];
    if (sid) req.session.mcpSessionId = sid;
    if (!method.startsWith('notifications/')) {
      const status = r.res?.status ?? 0, pb = r.parsed;
      const consentUrl = findConsentUrl(pb);
      const rec = { at: startedAt, mcp: method, tool: params?.name, status, ms: r.ev.ms, rpcError: pb?.error?.message || null, consentUrl,
        toolCount: pb?.result?.tools?.length, ok: status === 200 && !pb?.error && !pb?.result?.isError, mcpSessionId: sid || req.session.mcpSessionId || null,
        authorization: redactHeaders({ authorization: headers.Authorization }).authorization };
      F(req).gateway.calls.push(rec);
      if (method === 'tools/call') F(req).toolCalls.push(rec);
      if (method === 'tools/call' && status === 200) collectSts(req, startedAt, params?.name); // fire and forget: the log lags a couple of seconds
    }
    return { status: r.res?.status ?? 502, body: r.parsed, error: r.ev.error };
  }

  // Finds an Okta consent / interaction URL anywhere in a response.
  const findConsentUrl = (b) => JSON.stringify(b || {}).match(/https?:\/\/[^"\\\s]+(?:consent|interaction|authorize)[^"\\\s]*/i)?.[0] || null;

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
        if (parsed?.error) return findConsentUrl(parsed) ? 'Okta needs the user to authorize GitHub access first. A consent link was returned.' : `MCP error ${parsed.error.code}: ${parsed.error.message}.`;
        const isErr = parsed?.result?.isError;
        return `The gateway forwarded ${name} to GitHub using a downstream token the agent never saw, and relayed the result${isErr ? ' (GitHub reported a tool-level error)' : ''}. ${ev.ms} ms round trip including the token exchange.`;
      }, 'toolcall');
    res.status(r.status).json({ ...r.body, consentUrl: findConsentUrl(r.body) });
  });


  // ---------- token flow (DAG) ----------
  // The downstream GitHub token is minted and held inside Okta, so nobody outside it can see it. What we can show
  // is Okta's own System Log record of the exchange. This uses the admin token from the shell the server was started in
  // (or an OKTA_API_TOKEN line in your local, gitignored .env); without it the STS stage simply has no log evidence.

  async function collectSts(req, sinceMs, tool) {
    if (!req.tenant.logToken) return;
    const sid = req.sessionID;
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
      const exchange = [...win].reverse().find((e) => e.eventType === STS_EVENT) || null;
      // No fresh exchange means the gateway may have reused a downstream token it already held; find the latest one for this agent.
      const latest = exchange ? null : (await get(q({ since: new Date(Date.now() - 864e5).toISOString(), sortOrder: 'DESCENDING', limit: '20', filter: `eventType sw "${STS_EVENT}"` }))).find((e) => e.subjectTokenClientId === req.tenant.clientId) || null;
      const consent = (await get(q({ since: new Date(Date.now() - 7 * 864e5).toISOString(), sortOrder: 'DESCENDING', limit: '1', filter: 'eventType eq "app.oauth2.token.oauth_sts.request_token"' })))[0] || null;
      stsEvidence.set(sid, { exchange, latest, reused: !exchange && !!latest, consent, window: win, checkedAt: new Date().toISOString(), tool });
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
      emit(sid, {
        step: 'mcp', node: 'sts', label: 'Okta System Log: the token exchange behind that call', method: 'GET', url: `${req.tenant.orgUrl}/api/v1/logs`,
        request: { headers: redactHeaders(hdr), body: { since: new Date(sinceMs - 5000).toISOString(), filter: 'token exchange + agent_gateway events' } },
        response: { status: 200, body: { exchange, mostRecentExchange: latest, gatewayEvents: gw, githubConsentOnFile: consent } },
        ms: Date.now() - started, outcome: exchange && exchange.result !== 'SUCCESS' ? 'error' : 'ok', narration,
      });
    } catch (e) {
      emit(sid, { step: 'mcp', node: 'sts', label: 'Okta System Log lookup failed', method: 'GET', url: `${req.tenant.orgUrl}/api/v1/logs`, request: { headers: redactHeaders(hdr) }, response: null, ms: Date.now() - started, error: String(e.message || e), outcome: 'error', narration: `Could not read Okta’s System Log: ${e.message}. The exchange still happened; only the evidence is missing.` });
    }
  }

  app.get('/api/flow', (req, res) => {
    const s = req.session, fl = s.flow || {}, t = s.tokens, g = fl.gateway?.calls || [], last = g[g.length - 1];
    const gOk = g.some((c) => c.status === 200 && !c.rpcError);
    const callOk = (fl.toolCalls || []).some((c) => c.ok);
    const consentUrl = last?.consentUrl || null;
    const ev = stsEvidence.get(req.sessionID) || null;
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
      code: { status: fl.code ? 'done' : 'idle', data: fl.code ? { authorization_code: fl.code, single_use: true, redirect_uri: req.tenant.redirectUri } : null },
      access: { status: t ? 'done' : fl.tokenError ? 'error' : 'idle', data: t ? { access_token: t.access_token, token_type: t.token_type, scope: t.scope, expires_in: t.expires_in, refresh_token: t.refresh_token ? mask(t.refresh_token) : 'none issued', header: dec?.header, claims: dec?.claims, expiresAt: t.obtained_at + (t.expires_in || 0) * 1000 } : fl.tokenError || null },
      idtoken: { status: idDec ? 'done' : t ? 'skipped' : 'idle', data: idDec ? { id_token: t.id_token, header: idDec.header, claims: idDec.claims } : null },
      gateway: { status: !g.length ? 'idle' : gOk ? 'done' : 'error', data: g.length ? { calls: g.slice(-8), audience_matches_gateway: dec?.claims?.aud === req.tenant.gatewayUrl, token_audience: dec?.claims?.aud, gateway: req.tenant.gatewayUrl } : null },
      sts: { status: stsS, data: stsS !== 'idle' ? { consentUrl, logAvailable: !!req.tenant.logToken, checkedAt: ev?.checkedAt, exchange: ev?.exchange || null, reused: !!ev?.reused, lastExchange: ev?.latest || null, consentOnFile: ev?.consent || null, oktaGatewayEvents: (ev?.window || []).filter((e) => e.eventType.startsWith('agent_gateway.')) } : null },
      ghtoken: { status: stsS === 'waiting' ? 'idle' : stsS, data: stsS !== 'idle' && stsS !== 'waiting' ? { visible: false, held_by: 'Okta. Never sent to this app or to the agent.', reused: !!ev?.reused, returned: ghRec ? { tokenTypes: ghRec.returnedTokenTypes, at: ghRec.at, responseTimeMs: ghRec.responseTimeMs, targetResourceOrn: ghRec.targetResourceOrn } : null, consentOnFile: ev?.consent ? { at: ev.consent.at, persistedTokenTypes: ev.consent.persistedTokenTypes } : null } : null },
      toolcall: { status: callOk ? 'done' : (fl.toolCalls || []).length ? 'error' : 'idle', data: (fl.toolCalls || []).length ? { calls: fl.toolCalls.slice(-6) } : null },
    };
    res.json({ nodes });
  });

  return app;
}

// Run as a server only when executed directly (npm start), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dotenv.config();
  const { OKTA_ORG_URL, GATEWAY_URL, CLIENT_ID, CLIENT_SECRET, PORT = 8080 } = process.env;
  for (const [k, v] of Object.entries({ OKTA_ORG_URL, GATEWAY_URL, CLIENT_ID, CLIENT_SECRET })) {
    if (!v) { console.error(`Missing ${k}. Copy .env.example to .env and fill it in (see README.md)`); process.exit(1); }
  }
  // Okta System Log evidence needs an admin token from the shell (or a local, gitignored .env); without it the STS stage has no log evidence.
  const config = { orgUrl: OKTA_ORG_URL, gatewayUrl: GATEWAY_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, logToken: process.env.OKTA_API_TOKEN, port: PORT };
  createApp(config).listen(PORT, () => console.log(`Agent Gateway demo running at http://localhost:${PORT}`));
}
