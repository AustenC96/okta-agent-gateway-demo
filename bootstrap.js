// Client for the demo platform's Bootstrap API: given a demo name, returns the configuration provisioned for this component.
// Protocol as used by the platform's Node quickstart (not formally documented): get a service token with the client
// credentials grant, then GET /bootstrap/{componentId}/{demoName} with it. Results are cached per demo.
const decodeExp = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp * 1000; } catch { return 0; } };

export function createBootstrap({
  appId, clientId, clientSecret,
  endpoint = 'https://api.demo.okta.com', tokenEndpoint = 'https://auth.demo.okta.com/oauth/token', audience = 'https://api.demo.okta.com',
  cacheMinutes = 60, fetchImpl = fetch, now = Date.now,
}) {
  if (!appId || !clientId || !clientSecret) throw new Error('Bootstrap needs DEMO_API_APP_ID, DEMO_API_CLIENT_ID and DEMO_API_CLIENT_SECRET');
  let token = null, pendingToken = null;
  const cache = new Map();

  async function serviceToken(force = false) {
    if (!force && token && token.expiresAt - 30000 > now()) return token.value;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const res = await fetchImpl(tokenEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'bootstrap', audience }),
      });
      if (!res.ok) throw new Error(`Bootstrap token request failed (${res.status})`);
      const j = await res.json();
      if (!j.access_token) throw new Error('Bootstrap token response had no access_token');
      token = { value: j.access_token, expiresAt: decodeExp(j.access_token) || now() + (j.expires_in || 300) * 1000 };
      return token.value;
    })().finally(() => { pendingToken = null; });
    return pendingToken;
  }

  async function fetchDemo(name, retry = true) {
    const res = await fetchImpl(`${endpoint}/bootstrap/${encodeURIComponent(appId)}/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${await serviceToken()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return null;
    if (res.status === 401 && retry) { await serviceToken(true); return fetchDemo(name, false); }
    if (!res.ok) throw new Error(`Bootstrap lookup failed (${res.status})`);
    return res.json();
  }

  return {
    // The demo's bootstrap record, or null if the platform does not know it.
    async get(name) {
      const hit = cache.get(name);
      if (hit && hit.at + cacheMinutes * 60000 > now()) return hit.value;
      const value = await fetchDemo(name);
      if (value) cache.set(name, { value, at: now() }); else cache.delete(name);
      return value;
    },
    evict(name) { cache.delete(name); },
    cacheSize: () => cache.size,
  };
}

// Maps a bootstrap record to the tenant settings the app runs on. Returns null when it lacks what the app needs.
// Which OIDC client the Agent Gateway flow should use, and where the gateway URL comes from, is still being confirmed with
// Demo Engineering, so for now both come from this record: the client from oidc_configuration and the gateway from the
// component setting `gatewayUrl`.
// The gateway URL is pasted by whoever attaches the component and the server calls it, so it must be an https Okta gateway address.
export function validGatewayUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    const hostOk = /(^|\.)(oktapreview|okta|okta-emea)\.com$/.test(u.hostname);
    return u.protocol === 'https:' && hostOk && !u.username && !u.password && !u.port && !u.search && !u.hash && u.pathname.length > 1 ? u.href : null;
  } catch { return null; }
}

export function toTenant(b) {
  const o = b?.oidc_configuration;
  const gatewayUrl = validGatewayUrl(b?.settings?.gatewayUrl);
  if (!o?.issuer || !o.client_id || !gatewayUrl) return null;
  let orgUrl;
  try { orgUrl = new URL(String(o.issuer).startsWith('http') ? o.issuer : `https://${o.issuer}`).origin; } catch { return null; }
  return { orgUrl, gatewayUrl, clientId: o.client_id, clientSecret: o.client_secret };
}
