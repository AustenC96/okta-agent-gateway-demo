// Turns environment variables into the config object createApp() expects. Shared by the local entry point (server.js)
// and the Vercel function (api/index.js) so both behave the same. Throws a readable Error for any bad setting.
import { createBootstrap, toTenant } from './bootstrap.js';
import { createHooks } from './hooks.js';
import { createMemoryStore, createRedisStore } from './store.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export function configFromEnv(env, { store, defer, redisFactory, log = console.log } = {}) {
  const { OKTA_ORG_URL, GATEWAY_URL, CLIENT_ID, CLIENT_SECRET, PORT = 8080, DEMO_API_APP_ID, DEMO_API_CLIENT_ID, DEMO_API_CLIENT_SECRET } = env;
  // Multi-tenant mode (hosted on the demo platform) is on when the Bootstrap credentials are present; otherwise the one
  // org in the environment is served, exactly as before.
  const multi = !!DEMO_API_APP_ID;
  const need = multi ? { DEMO_API_APP_ID, DEMO_API_CLIENT_ID, DEMO_API_CLIENT_SECRET, BASE_URI: env.BASE_URI } : { OKTA_ORG_URL, GATEWAY_URL, CLIENT_ID, CLIENT_SECRET };
  for (const [k, v] of Object.entries(need)) if (!v) throw new Error(`Missing ${k}. Copy .env.example to .env and fill it in (see README.md)`);

  // The public address of this app. It is never taken from request headers, because Okta needs the exact value
  // registered on the OIDC app and a spoofed Host header must not be able to change it.
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

  // Where state lives. A shared Redis is required on serverless hosts; otherwise it stays in this process's memory.
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  const serverless = !!env.VERCEL;
  if (serverless && !store && !(redisUrl && redisToken)) throw new Error('Running on Vercel needs a Redis store: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  if (serverless && !env.SESSION_SECRET) throw new Error('Running on Vercel needs SESSION_SECRET, because every request may be handled by a different instance');
  const chosenStore = store || (redisUrl && redisToken ? createRedisStore(redisFactory({ url: redisUrl, token: redisToken })) : createMemoryStore());

  let multiConfig = {};
  if (multi) {
    const bootstrap = createBootstrap({ appId: DEMO_API_APP_ID, clientId: DEMO_API_CLIENT_ID, clientSecret: DEMO_API_CLIENT_SECRET, cacheMinutes: Number(env.CACHE_DURATION) || 60 });
    const strategy = env.RESOLUTION_STRATEGY || 'query';
    if (!['query', 'subdomain'].includes(strategy)) throw new Error('RESOLUTION_STRATEGY must be query or subdomain');
    multiConfig = {
      resolution: { strategy, baseHost: new URL(origin).hostname },
      getTenant: async (name) => (name === 'default' ? null : toTenant(await bootstrap.get(name))),
      // Changes inside a demo's Okta org stay off until Demo Engineering confirms which client and scopes we may use.
      hooks: createHooks({ bootstrap, defer, tenantChanges: env.HOOKS_MODIFY_TENANT === 'true', log: (m, d) => log('[hooks]', m, JSON.stringify(d || {})) }),
    };
  }
  return {
    ...multiConfig, origin, allowLocal: local, store: chosenStore, defer, port: PORT,
    transport: serverless || env.EVENT_TRANSPORT === 'poll' ? 'poll' : 'stream',
    sessionSecret: env.SESSION_SECRET, trustProxy: tp ? (/^\d+$/.test(tp) ? Number(tp) : tp) : undefined,
    orgUrl: OKTA_ORG_URL, gatewayUrl: GATEWAY_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    // Reading the System Log needs an admin token, so it is only offered for the single configured org.
    logToken: multi ? undefined : env.OKTA_API_TOKEN,
  };
}
