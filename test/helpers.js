import { createApp } from '../server.js';

// Starts the app on a random port with dummy config. Nothing here touches a real Okta org or reads .env.
export async function startApp(overrides = {}) {
  const config = {
    orgUrl: 'https://example.oktapreview.com',
    gatewayUrl: 'https://example.gateway.oktapreview.com/mcp/servers/test',
    clientId: 'test-client', clientSecret: 'test-secret', port: 0, ...overrides,
  };
  const server = await new Promise((resolve) => { const s = createApp(config).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// A minimal cookie jar so one test can act as two separate browsers.
export function browser(base) {
  let cookie = '';
  return async (path, init = {}) => {
    const res = await fetch(base + path, { ...init, redirect: 'manual', headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.split(';')[0];
    return res;
  };
}
