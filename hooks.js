// Lifecycle webhooks from the demo platform (request, create, update, delete, execute).
//
// The platform does not document any signature or secret on these calls, so a request body is never trusted by itself:
//  - the response is sent first (the platform expects an acknowledgement within 3 seconds) and the work happens afterwards;
//  - before acting, we ask the Bootstrap API, with our own credentials, whether this demo really exists;
//  - the callback URL must be on the platform's own host over https.
// Changes inside a demo's Okta org are stubs behind a flag until it is confirmed which client and scopes we may use.
import express from 'express';
import { NAME_RE } from './tenant.js';
import { shape, safeValues } from './shape.js';

// The component form names the hooks request/attach/update/execute/detach; create and destroy are the deprecated names for attach and detach.
const EVENTS = { request: 'request', attach: 'create', create: 'create', update: 'update', detach: 'delete', delete: 'delete', destroy: 'delete', execute: 'execute' };

// application.settings wraps each value as { default, instance }; component.settings is already plain. Prefer the user's value.
function plainSettings(raw) {
  return Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, v && typeof v === 'object' && 'default' in v ? (v.instance || v.default) : v]));
}

// The platform's docs show two payload shapes (event/component/oidcConfiguration and application/oidc_configuration); read both.
export function normalize(type, body = {}) {
  const comp = body.component || body.application || {};
  return {
    type: EVENTS[type] || null,
    callback: body.event?.callback || null,
    demoName: typeof body.demonstration?.name === 'string' ? body.demonstration.name.toLowerCase() : null,
    owner: body.demonstration?.owner || null,
    idpType: body.idp?.type || null,
    settings: plainSettings(comp.settings),
    oidc: comp.oidcConfiguration || comp.oidc_configuration || null,
  };
}

export function callbackAllowed(raw, allowedHosts = ['api.demo.okta.com']) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.port && allowedHosts.includes(u.hostname); }
  catch { return false; }
}

export function createHooks({ bootstrap, baseUri, tenantChanges = false, allowedCallbackHosts, fetchImpl = fetch, log = () => {}, defer = (p) => p.catch(() => {}), actions = {} }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  async function patchCallback(url, body) {
    if (!callbackAllowed(url, allowedCallbackHosts)) { log('callback refused', { reason: 'host not allowed' }); return false; }
    const res = await fetchImpl(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return res.ok;
  }

  async function handle(ev) {
    const { type, demoName, callback } = ev;
    try {
      if (type === 'delete') {
        bootstrap.evict(demoName);                       // harmless whoever sent it: the next lookup just refetches
        if (tenantChanges && actions.delete) await actions.delete(ev);
        return;
      }
      if (type === 'request') return;                    // nothing to veto yet
      bootstrap.evict(demoName);                         // update/create/execute must see fresh settings
      const known = await bootstrap.get(demoName);
      if (!known) { log('ignored: platform does not know this demo', { demoName, type }); if (callback) await patchCallback(callback, { state: 'fail', message: 'Demo not found', level: 'error' }); return; }
      if (type === 'create' || type === 'update') {
        if (tenantChanges && actions[type]) await actions[type](ev, known);
        else log('tenant changes disabled; nothing modified', { demoName, type });
      }
      // launchUrl is what the platform shows as the component's launch link; the query form is how this app finds the demo.
      const launchUrl = baseUri ? `${baseUri}/?demoName=${encodeURIComponent(demoName)}` : undefined;
      if (callback) await patchCallback(callback, { state: 'finish', message: 'Agent Gateway demo configured', ...(launchUrl && { launchUrl }) });
    } catch (e) {
      log('hook failed', { demoName, type, error: String(e.message || e) });
      if (callback) await patchCallback(callback, { state: 'fail', message: String(e.message || e).slice(0, 200) }).catch(() => {});
    }
  }

  router.post('/:event', (req, res) => {
    const type = EVENTS[req.params.event];
    if (!type) return res.sendStatus(404);
    log('hook payload shape', { event: req.params.event, shape: shape(req.body), settings: safeValues((req.body?.component || req.body?.application)?.settings) });
    const ev = normalize(req.params.event, req.body);
    if (!ev.demoName || !NAME_RE.test(ev.demoName)) return res.status(400).json({ error: 'Missing or invalid demo name' });
    res.sendStatus(202);                                 // acknowledge first; the platform waits only a few seconds
    defer(handle(ev));
  });
  return router;
}
