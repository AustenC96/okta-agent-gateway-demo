// Turns environment variables into the config object createApp() expects. Throws a readable Error for any bad setting.
import { createMemoryStore } from './store.js';
import { personasFromEnv } from './personas.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export function configFromEnv(env, { store } = {}) {
  const { OKTA_ORG_URL, GATEWAY_URL, CLIENT_ID, CLIENT_SECRET, CALLBACK_PATH, PORT = 8080 } = env;
  // A client whose ID is a URL (Client ID Metadata Document, e.g. Claude Code's) is a public client: PKCE only, no secret.
  const publicClient = /^https:\/\//.test(CLIENT_ID || '');
  const need = { OKTA_ORG_URL, GATEWAY_URL, CLIENT_ID, ...(publicClient ? {} : { CLIENT_SECRET }) };
  for (const [k, v] of Object.entries(need)) if (!v) throw new Error(`Missing ${k}. Copy .env.example to .env and fill it in (see README.md)`);

  // The address this app is reached at. It is never taken from request headers, because Okta needs the exact value
  // registered on the OIDC app and a spoofed Host header must not be able to change it. Unset means http://localhost:<port>.
  let origin = env.BASE_URI ? env.BASE_URI.replace(/\/+$/, '') : undefined;
  if (origin) {
    let u; try { u = new URL(origin); } catch { /* handled below */ }
    if (!u || !['http:', 'https:'].includes(u.protocol) || u.pathname !== '/' || u.search || u.hash || (u.protocol === 'http:' && !LOCAL_HOSTS.includes(u.hostname))) {
      throw new Error('BASE_URI must be an https origin such as https://demo.example.com (http is allowed only for localhost)');
    }
    origin = u.origin;
  }
  const local = !origin || LOCAL_HOSTS.includes(new URL(origin).hostname);
  const tp = env.TRUST_PROXY;
  return {
    origin, allowLocal: local, store: store || createMemoryStore(), port: PORT,
    transport: env.EVENT_TRANSPORT === 'poll' ? 'poll' : 'stream',
    sessionSecret: env.SESSION_SECRET, trustProxy: tp ? (/^\d+$/.test(tp) ? Number(tp) : tp) : undefined,
    personas: personasFromEnv(env),
    orgUrl: OKTA_ORG_URL, gatewayUrl: GATEWAY_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET || undefined, callbackPath: CALLBACK_PATH,
    // Reading the System Log needs an admin token; without one the token-exchange stages show as "inferred".
    logToken: env.OKTA_API_TOKEN,
  };
}
