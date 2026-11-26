// Builds (and removes) the Okta side of the demo, using Okta's APIs:  npm run okta -- <command>
//
//   status                       read only: shows what exists and what is missing
//   identity [--add-me]          step 1: groups, the three fictional users, and the two custom authorization servers (--add-me puts you in all three groups)
//   connect --api-url <url>      step 2: MCP servers, brokered-consent credentials, gateways, tools, agents and the agent -> gateway links
//   gateways                     prints each team gateway's URL and token issuer as JSON (read only; infra/deploy-agents.sh uses it)
//   env                          prints the lines to put in .env (agent client IDs and secrets the script created)
//   teardown                     removes everything the demo created (by name)
//
// Safe to run again: every step looks for the object by name first and only creates what is missing, so a half-finished run can be resumed.
// It reads OKTA_ORG_URL and OKTA_API_TOKEN (a SUPER_ADMIN SSWS token) from the environment or .env, and never prints a secret.
// Anything it generates that cannot be read back later (user passwords, agent client secrets) is saved to .okta-demo.json, which is gitignored.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { EXPECTED } from './preflight-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const has = (n) => args.includes(`--${n}`);
const env = process.env;

const base = (env.OKTA_ORG_URL || '').replace(/\/+$/, '');
const token = env.OKTA_API_TOKEN || env.OKTA_AGENTGATEWAY_API_TOKEN;
const CALLBACK = `http://localhost:${env.PORT || 8080}/authorization-code/callback`;

// --tag lets you rehearse in an org that already has the real demo: every name, login and path gets the tag added.
const TAG = flag('tag') || '';
const nm = (s) => (TAG ? `${s} ${TAG}` : s);
const slug = (s) => (TAG ? `${s}-${TAG}` : s);
const STATE_FILE = path.join(ROOT, TAG ? `.okta-demo.${TAG}.json` : '.okta-demo.json');
const DRY = cmd === 'status';

// ---------- what the demo is made of ----------
// The names must match what the app, the pre-flight check and the tool names expect (see personas.js and scripts/preflight-lib.mjs).
const TEAMS = [
  { key: 'ethan', first: 'Ethan', last: 'Park', title: 'Software Engineer', group: 'Engineering', agent: 'Engineering Agent', gateway: 'Engineering Tools', path: 'engineering-tools', github: true },
  {
    key: 'sofia', first: 'Sofia', last: 'Reyes', title: 'Account Executive', group: 'Sales', agent: 'Sales Agent', gateway: 'Sales Tools', path: 'sales-tools',
    route: 'crm', as: { name: 'CRM MCP', audience: 'api://agw-demo-crm', policy: 'CRM MCP Access', rule: 'Sales Only', desc: 'CRM demo MCP server',
      scopes: [['crm:read', 'Read CRM data', 'Search customers and read deals'], ['crm:write', 'Update CRM data', 'Change the stage of a deal']] },
  },
  {
    key: 'hannah', first: 'Hannah', last: 'Cho', title: 'HR Business Partner', group: 'HR', agent: 'HR Agent', gateway: 'HR Resources', path: 'hr-resources',
    route: 'hr', as: { name: 'HR MCP', audience: 'api://agw-demo-hr', policy: 'HR MCP Access', rule: 'HR Only', desc: 'HR demo MCP server',
      scopes: [['hr:read', 'Read the HR directory', 'List employees and read directory details'], ['hr:sensitive', 'Read sensitive HR data', 'Read employee compensation']] },
  },
];
const domain = 'agentgateway.demo';
const loginOf = (t) => `${t.first}.${t.last}${TAG ? `.${TAG}` : ''}@${domain}`.toLowerCase();

// ---------- output ----------
const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const ICON = { ok: c(32, '✓'), warn: c(33, '!'), fail: c(31, '✗'), info: c(36, '·') };
const tally = { ok: 0, warn: 0, fail: 0 };
const say = (level, text, detail) => { tally[level] = (tally[level] || 0) + 1; console.log(`  ${ICON[level]} ${text}${detail ? c(2, `  ${detail}`) : ''}`); };
const head = (t) => console.log(`\n${c(1, t)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- state (things only known at creation time) ----------
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { users: {}, authServers: {}, agents: {} };
function save() {
  if (DRY) return;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  try { chmodSync(STATE_FILE, 0o600); } catch { /* not fatal */ }
}

// ---------- Okta client ----------
async function api(method, p, body, { allow = [] } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(base + p, {
      method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `SSWS ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && attempt < 4) { await sleep(2000 * (attempt + 1)); continue; }
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!r.ok && !allow.includes(r.status)) {
      const why = json?.errorSummary || String(text).slice(0, 160);
      const causes = json?.errorCauses?.length ? ` (${json.errorCauses.map((x) => x.errorSummary).join('; ')})` : '';
      throw new Error(`${method} ${p.split('?')[0]} -> HTTP ${r.status} ${why}${causes}`);
    }
    return { status: r.status, json, location: r.headers.get('location') };
  }
}
const get = async (p) => (await api('GET', p)).json;
const rel = (loc) => (loc || '').replace(base, '');

// Operations (agents, gateways) finish asynchronously: poll the Location header until they complete.
async function waitOp(location, what) {
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const op = await get(rel(location));
    if (/COMPLETED/i.test(op.status)) return op;
    if (/FAILED|ERROR/i.test(op.status)) throw new Error(`${what} failed: ${JSON.stringify(op.error || op).slice(0, 200)}`);
  }
  throw new Error(`${what} did not finish in time`);
}
async function until(fn, what, tries = 30, wait = 2000) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(wait); }
  throw new Error(`${what} did not appear in time`);
}

// find or create, with a clear line of output either way
async function ensure(label, find, create) {
  const found = await find();
  if (found) { say('ok', `${label}: exists`); return found; }
  if (DRY) { say('warn', `${label}: missing`); return null; }
  const made = await create();
  say('ok', `${label}: created`);
  return made;
}
const attempt = async (label, fn) => { try { return await fn(); } catch (e) { say('fail', `${label}: ${e.message}`); return null; } };

// ---------- step 1: identity ----------
const password = () => {
  const pick = (s) => s[randomInt(s.length)];
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ', a = 'abcdefghijkmnpqrstuvwxyz', n = '23456789';
  const x = [pick(A), pick(A), pick(a), pick(a), pick(a), pick(a), pick(a), pick(n), pick(n), pick(n), pick(a), pick(a), pick(A), pick(n), pick(A), pick(a)];
  for (let i = x.length - 1; i > 0; i--) { const j = randomInt(i + 1); [x[i], x[j]] = [x[j], x[i]]; }
  return `${x.join('')}!`;
};

const groups = {};
async function findGroup(name) {
  const list = await get(`/api/v1/groups?q=${encodeURIComponent(name)}&limit=50`);
  return list.find((g) => g.profile.name === name) || null;
}
async function findUser(login) {
  const list = await get(`/api/v1/users?search=${encodeURIComponent(`profile.login eq "${login}"`)}`);
  return list[0] || null;
}
async function findAuthServer(name) {
  return (await get('/api/v1/authorizationServers?limit=200')).find((a) => a.name === name) || null;
}

async function identity() {
  head('Groups');
  for (const t of TEAMS) {
    groups[t.key] = await attempt(`${nm(t.group)} group`, () => ensure(`${nm(t.group)} group`, () => findGroup(nm(t.group)),
      async () => (await api('POST', '/api/v1/groups', { profile: { name: nm(t.group), description: `${t.group} team (Agent Gateway demo)` } })).json));
  }
  head('Fictional users (one per team, so each person can only reach their own team)');
  for (const t of TEAMS) {
    const login = loginOf(t);
    const grp = groups[t.key];
    const user = await attempt(`${login}`, () => ensure(`${login}`, () => findUser(login), async () => {
      const pw = password();
      const u = (await api('POST', '/api/v1/users?activate=true', { profile: { firstName: t.first, lastName: t.last, email: login, login, department: t.group, title: t.title }, credentials: { password: { value: pw } } })).json;
      state.users[t.key] = { login, password: pw };
      save();
      return u;
    }));
    if (user && grp && !DRY) await api('PUT', `/api/v1/groups/${grp.id}/users/${user.id}`);
  }
  if (has('add-me') && !DRY) {
    // Discovering a brokered server's tools needs a one-time consent from an admin who belongs to the team's group, so add yourself to all three.
    const me = await get('/api/v1/users/me');
    for (const t of TEAMS) if (groups[t.key]) await api('PUT', `/api/v1/groups/${groups[t.key].id}/users/${me.id}`);
    say('ok', `${me.profile.login} added to all three groups`, 'so you can approve the one-time consents and test each agent as an admin');
  }
  head('Custom authorization servers (they issue the tokens the MCP servers check)');
  for (const t of TEAMS.filter((x) => x.as)) {
    const a = t.as, grp = groups[t.key];
    const server = await attempt(`${nm(a.name)} authorization server`, () => ensure(`${nm(a.name)} authorization server`, () => findAuthServer(nm(a.name)), async () => {
      if (!grp) throw new Error(`needs the ${t.group} group first`);
      const s = (await api('POST', '/api/v1/authorizationServers', { name: nm(a.name), description: a.desc, audiences: [a.audience + (TAG ? `-${TAG}` : '')] })).json;
      for (const [name, displayName, description] of a.scopes) {
        await api('POST', `/api/v1/authorizationServers/${s.id}/scopes`, { name, displayName, description, consent: 'IMPLICIT', default: false, metadataPublish: 'ALL_CLIENTS' });
      }
      const pol = (await api('POST', `/api/v1/authorizationServers/${s.id}/policies`, { type: 'OAUTH_AUTHORIZATION_POLICY', name: `${nm(a.policy)}`, description: 'MCP Server Access', priority: 1, conditions: { clients: { include: ['ALL_CLIENTS'] } } })).json;
      await api('POST', `/api/v1/authorizationServers/${s.id}/policies/${pol.id}/rules`, {
        type: 'RESOURCE_ACCESS', name: nm(a.rule), priority: 1,
        conditions: {
          people: { users: { include: [], exclude: [] }, groups: { include: [grp.id], exclude: [] } },
          grantTypes: { include: ['authorization_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] },
          scopes: { include: a.scopes.map((x) => x[0]) },
          xaaSupportedIdentityProvider: { provider: 'ANY' },
        },
        actions: { token: { accessTokenLifetimeMinutes: 60, refreshTokenLifetimeMinutes: 129600, refreshTokenWindowMinutes: 10080 } },
      });
      return s;
    }));
    if (server) { state.authServers[t.key] = { id: server.id, issuer: server.issuer, audience: server.audiences?.[0] }; save(); }
  }
  if (!DRY && tally.fail === 0) {
    console.log(`\n  Issuers for the AWS step (also saved in ${path.basename(STATE_FILE)}):`);
    for (const t of TEAMS.filter((x) => x.as)) console.log(`    ${t.key === 'sofia' ? 'CRM' : 'HR '}  ${state.authServers[t.key]?.issuer}   audience ${state.authServers[t.key]?.audience}`);
  }
}

// ---------- step 2: connect ----------
const orgIdOf = (orn) => orn.split(':')[3];
const envOf = (orn) => orn.split(':')[1];
const mcpListPath = '/resource-servers/api/v1/mcp-servers';

async function findMcp(name) {
  const list = (await get(`${mcpListPath}?limit=100`)).data || [];
  return list.find((m) => m.metadata?.displayName === name) || null;
}
async function findCredentialSet(mcpOrn) {
  const list = (await get('/resource-servers/api/v1/client-auth-settings?limit=200')).data || [];
  return list.find((x) => x.resourceOrn === mcpOrn && (x.purpose || []).includes('STS')) || null;
}

async function ensureMcpServer(displayName, resourceUrl, description) {
  return ensure(`${displayName} server record`, () => findMcp(displayName), async () => {
    await api('POST', mcpListPath, { displayName, description, resourceUrl });
    return until(() => findMcp(displayName), `${displayName} registration`);
  });
}
async function authServerOf(mcp) {
  return until(async () => ((await get(`${mcpListPath}/${mcp.id}/authorization-servers`)).data || [])[0], `the authorization server of ${mcp.metadata?.displayName}`, 30, 2000);
}

async function ensureCredentialSet(t, mcp) {
  const label = `${mcp.metadata.displayName} credentials (brokered consent)`;
  return ensure(label, () => findCredentialSet(mcp.orn), async () => {
    const orgId = orgIdOf(mcp.orn);
    if (t.github) {
      const id = flag('github-client-id') || env.GITHUB_APP_CLIENT_ID, secret = flag('github-client-secret') || env.GITHUB_APP_CLIENT_SECRET;
      if (!id || !secret) throw new Error('needs the GitHub App client ID and secret (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET, see docs/SETUP.md part 4)');
      let eas = ((await get(`${mcpListPath}/${mcp.id}/authorization-servers`)).data || [])[0];
      if (!eas) {
        await api('POST', `${mcpListPath}/${mcp.id}/authorization-servers`, {
          type: 'MANUAL', issuer: 'https://github.com/login/oauth', protocolConfigured: ['STS'],
          metadata: { authorizationEndpoint: 'https://github.com/login/oauth/authorize', tokenEndpoint: 'https://github.com/login/oauth/access_token', tokenEndpointAuthMethod: 'client_secret_basic' },
        });
        eas = await authServerOf(mcp);
      }
      return (await api('POST', '/resource-servers/api/v1/client-auth-settings', {
        name: 'GitHub App credentials', purpose: ['STS'], protocol: 'OAUTH2', registrationMethod: 'STATIC', resourceOrn: mcp.orn, authorizationServerOrn: eas.orn,
        clientCredentials: { clientId: id, clientSecret: secret },
      })).json;
    }
    // A custom authorization server needs a client of its own: this "STS client" is what Okta uses to run the one-time consent and the token exchange.
    const eas = await authServerOf(mcp);
    const app = (await api('POST', '/api/v1/apps', {
      name: 'oidc_client', label: `${mcp.metadata.displayName} STS Client`, signOnMode: 'OPENID_CONNECT',
      credentials: { oauthClient: { token_endpoint_auth_method: 'client_secret_basic', pkce_required: false } },
      settings: { oauthClient: { redirect_uris: [`${base}/oauth2/v1/sts/callback`], response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
        application_type: 'web', consent_method: 'REQUIRED', issuer_mode: 'DYNAMIC', refresh_token: { rotation_type: 'STATIC' } } },
    })).json;
    await api('PUT', `/api/v1/apps/${app.id}/groups/${groups[t.key].id}`, {});
    return (await api('POST', '/resource-servers/api/v1/client-auth-settings', {
      name: `${t.group} STS Client`, purpose: ['STS'], protocol: 'OAUTH2', registrationMethod: 'STATIC', resourceOrn: mcp.orn, authorizationServerOrn: eas.orn,
      clientCredentials: { clientId: app.credentials.oauthClient.client_id, clientSecret: app.credentials.oauthClient.client_secret },
      oauthConfiguration: { scopes: t.as.scopes.map((x) => x[0]) },
    })).json;
  });
}

// Reading a brokered server's tool list uses the credentials above, and Okta first needs ONE consent from the admin running this
// (the same consent a user gives on their first tool call). Okta answers 409 with a link: open it, approve, and carry on.
async function discoverWithConsent(mcp, idp) {
  const go = () => api('POST', `${mcpListPath}/${mcp.id}/metadata/discover`, { type: 'CLIENT_AUTH_SETTINGS', clientAuthSettingsOrn: idp });
  try { return await go(); } catch (e) {
    const link = /consent is required \((https:\/\/\S+?)\)/.exec(e.message)?.[1];
    if (!link) throw e;
    console.log(`\n    One-time consent needed for ${mcp.metadata.displayName}. Open this link in a browser where you are signed in to Okta as an administrator`);
    console.log(`    who belongs to the team's group, approve it, then come back here:\n\n    ${link}\n`);
    if (!process.stdin.isTTY) throw new Error('consent needed: approve the link above, then run the same command again (nothing is repeated)');
    await new Promise((resolve) => { process.stdout.write('    Press Enter after approving... '); process.stdin.once('data', resolve); });
    process.stdin.pause();
    return go();
  }
}

async function ensureGateway(t) {
  const label = `${nm(t.gateway)} gateway`;
  const list = async () => ((await get('/workload-principals/api/v1/virtual-mcp-servers')).data || []).find((g) => g.profile.displayName === nm(t.gateway)) || null;
  const gw = await ensure(label, list, async () => {
    const r = await api('POST', '/workload-principals/api/v1/virtual-mcp-servers', { resourcePath: slug(t.path), profile: { displayName: nm(t.gateway), description: `${t.group} team gateway (Agent Gateway demo)` } });
    const op = await waitOp(r.location, label);
    return get(`/workload-principals/api/v1/virtual-mcp-servers/${op.resource.id}`);
  });
  if (gw && gw.status !== 'ACTIVE' && !DRY) { await api('POST', `/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/lifecycle/activate`); say('ok', `${label}: activated`); }
  return gw;
}

async function ensureConnection(t, gw, mcp, credSet) {
  const want = EXPECTED[t.key];
  const label = `${nm(t.gateway)} -> ${want.mcp} connection`;
  const conns = async () => (await get(`/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/connections`)).data || [];
  const conn = await ensure(label, async () => (await conns()).find((k) => k.resource?.name === mcp.metadata.displayName) || null, async () => {
    const orn = `orn:${envOf(mcp.orn)}:idp:${orgIdOf(mcp.orn)}:client-auth-settings:${credSet.id}`;
    return (await api('POST', `/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/connections`, { connectionType: 'STS_ACCESS_TOKEN', resource: { orn } })).json;
  });
  if (!conn) return;

  // Ask Okta to read the MCP server's tool list (needs the credentials above), then switch on exactly the tools this team should have.
  const capPath = `/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/connections/${conn.id}/capabilities`;
  const have = ((await get(capPath)).data || []).map((q) => q.profile?.alias);
  const need = want.tools.map((x) => want.prefix + x);
  if (need.every((x) => have.includes(x))) { say('ok', `${nm(t.gateway)} exposes its ${need.length} tools: already on`); return; }
  if (DRY) { say('warn', `${nm(t.gateway)} tools: not all enabled yet`); return; }
  const idp = `orn:${envOf(mcp.orn)}:idp:${orgIdOf(mcp.orn)}:client-auth-settings:${credSet.id}`;
  const filter = encodeURIComponent(`credential.clientAuthSettingsId eq "${credSet.id}"`);
  const listTools = async () => (await get(`${mcpListPath}/${mcp.id}/tools?limit=200&search=${filter}`)).data || [];
  let tools = await listTools();
  if (!want.tools.every((x) => tools.some((y) => y.name === x))) {
    const d = await discoverWithConsent(mcp, idp);
    if (d.location) {
      for (let i = 0; i < 30; i++) { await sleep(2000); const o = await (await fetch(d.location, { headers: { Authorization: `SSWS ${token}`, Accept: 'application/json' } })).json().catch(() => ({})); if (/COMPLETE|FAIL/i.test(o.status || '')) break; }
    }
    tools = await listTools();
  }
  let added = 0;
  for (const name of want.tools) {
    if (have.includes(want.prefix + name)) continue;
    const tool = tools.find((x) => x.name === name);
    if (!tool) { say('fail', `${nm(t.gateway)}: tool ${name} was not discovered on ${want.mcp}`); continue; }
    await api('POST', capPath, { sourceOrn: `orn:${envOf(mcp.orn)}:directory:${orgIdOf(mcp.orn)}:resource-servers:mcp:${mcp.id}:tools:${tool.id}` });
    added++;
  }
  say('ok', `${nm(t.gateway)}: switched on ${added} tool${added === 1 ? '' : 's'}`, need.join(', '));
}

async function ensureAgent(t, gw) {
  const name = nm(t.agent);
  const agents = async () => (await get('/workload-principals/api/v1/ai-agents')).data || [];
  const agent = await ensure(`${name}`, async () => (await agents()).find((a) => a.profile.name === name) || null, async () => {
    // The agent's sign-in is an ordinary OIDC app. Assigning the app to a team's group is what limits the agent to that team (Okta checks it at sign-in).
    const app = (await api('POST', '/api/v1/apps', {
      name: 'oidc_client', label: name, signOnMode: 'OPENID_CONNECT',
      credentials: { oauthClient: { token_endpoint_auth_method: 'client_secret_basic', pkce_required: false } },
      settings: { oauthClient: { redirect_uris: [CALLBACK], response_types: ['code'],
        grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:jwt-bearer'], application_type: 'web', consent_method: 'TRUSTED' } },
    })).json;
    await api('PUT', `/api/v1/apps/${app.id}/groups/${groups[t.key].id}`, {});
    state.agents[t.key] = { clientId: app.credentials.oauthClient.client_id, clientSecret: app.credentials.oauthClient.client_secret };
    save();
    const r = await api('POST', '/workload-principals/api/v1/ai-agents', { profile: { name, description: `Agent for the ${t.group} team` }, signOnProvider: { type: 'EXISTING_APP', appInstanceId: app.id } });
    const op = await waitOp(r.location, name);
    return get(`/workload-principals/api/v1/ai-agents/${op.resource.id}`);
  });
  if (!agent || !gw) return;
  // The delegation link is what lets this agent (and only this agent) call this gateway.
  const gwOrn = `orn:okta:directory:${orgIdOf(gw.orn)}:workload-principals:virtual-mcp:${gw.id}`;
  const links = async () => (await get(`/workload-principals/api/v1/delegation-links?filter=${encodeURIComponent(`to.resourceOrn eq "${gwOrn}"`)}`)).data || [];
  await ensure(`${name} -> ${nm(t.gateway)} link`, async () => (await links()).find((l) => l.from.clientOrn.endsWith(`:${agent.id}`)) || null, async () =>
    (await api('POST', '/workload-principals/api/v1/delegation-links', { from: { type: 'OKTA_AUTHORIZATION_SERVER', clientOrn: `orn:okta:directory:${orgIdOf(gw.orn)}:workload-principals:ai-agents:${agent.id}`, tokenType: 'ACCESS_TOKEN' }, to: { resourceOrn: gwOrn } })).json);
}

async function connect() {
  const apiUrl = (flag('api-url') || env.MCP_API_BASE || '').replace(/\/+$/, '');
  if (!apiUrl && !DRY) throw new Error('--api-url is required: the https URL of your API Gateway (the McpApiUrl output of the AWS stack)');
  for (const t of TEAMS) groups[t.key] = await findGroup(nm(t.group));
  const missing = TEAMS.filter((t) => !groups[t.key]);
  if (missing.length) { say('fail', `Missing groups (${missing.map((t) => t.group).join(', ')}): run the identity step first`); return; }

  for (const t of TEAMS) {
    head(`${t.group}: ${t.first} -> ${t.agent} -> ${t.gateway}`);
    const want = EXPECTED[t.key];
    const url = t.github ? 'https://api.githubcopilot.com/mcp/' : `${apiUrl}/${t.route}`;
    const skipResource = has('no-resources');
    const mcp = skipResource ? null : await attempt(`${want.mcp}`, () => ensureMcpServer(want.mcp, url, t.github ? 'GitHub MCP server (Copilot endpoint)' : `${t.group} demo data in AWS`));
    const cred = mcp ? await attempt(`${want.mcp} credentials`, () => ensureCredentialSet(t, mcp)) : null;
    const gw = await attempt(`${nm(t.gateway)}`, () => ensureGateway(t));
    if (gw && mcp && cred) await attempt(`${nm(t.gateway)} connection`, () => ensureConnection(t, gw, mcp, cred));
    await attempt(`${nm(t.agent)}`, () => ensureAgent(t, gw));
  }
}

// ---------- gateways (read only) ----------
// The AgentCore runtimes must accept exactly the tokens a team's gateway accepts: the gateway URL is the token's audience and the authorization
// server Okta made for that gateway is its issuer. Okta names that server "Gateway: <path>" and gives it the gateway URL as its audience.
async function printGateways() {
  const basePath = (await get('/workload-principals/api/v1/virtual-mcp-settings')).basePath;
  const servers = await get('/api/v1/authorizationServers?limit=200');
  const out = {};
  for (const t of TEAMS) {
    // A hand-built Engineering gateway may have a different path: GATEWAY_URL (from .env) wins when it is set.
    const path = t.github && env.GATEWAY_URL ? new URL(env.GATEWAY_URL).pathname.split('/').filter(Boolean).pop() : slug(t.path);
    const url = `${basePath}/${path}`;
    const as = servers.find((a) => (a.audiences || []).includes(url));
    if (!as) { console.error(`No gateway found at ${url}: run "npm run okta -- connect" first.`); process.exit(1); }
    out[t.key] = { url, issuer: as.issuer };
  }
  console.log(JSON.stringify(out));
}

// ---------- env ----------
function printEnv() {
  const a = state.agents || {};
  const miss = (t) => `# ${t} was created before this script ran, so its secret was not saved: copy it from the Admin Console (the agent's app, Sign On tab)`;
  getBase().then((gwBase) => {
    const lines = [`OKTA_ORG_URL=${base}`, `GATEWAY_URL=${gwBase ? `${gwBase}/${slug('engineering-tools')}` : '<your Engineering gateway URL>'}`];
    lines.push(a.ethan ? `CLIENT_ID=${a.ethan.clientId}\nCLIENT_SECRET=${a.ethan.clientSecret}` : `${miss('Engineering Agent')}\nCLIENT_ID=\nCLIENT_SECRET=`);
    lines.push(a.sofia ? `SALES_AGENT_CLIENT_ID=${a.sofia.clientId}\nSALES_AGENT_CLIENT_SECRET=${a.sofia.clientSecret}` : `${miss('Sales Agent')}\nSALES_AGENT_CLIENT_ID=\nSALES_AGENT_CLIENT_SECRET=`);
    lines.push(a.hannah ? `HR_AGENT_CLIENT_ID=${a.hannah.clientId}\nHR_AGENT_CLIENT_SECRET=${a.hannah.clientSecret}` : `${miss('HR Agent')}\nHR_AGENT_CLIENT_ID=\nHR_AGENT_CLIENT_SECRET=`);
    console.log(lines.join('\n'));
  });
}
async function getBase() { try { return (await get('/workload-principals/api/v1/virtual-mcp-settings')).basePath; } catch { return null; } }

// ---------- teardown ----------
async function teardown() {
  head('Removing the demo from Okta');
  const del = async (label, fn) => { try { await fn(); say('ok', `${label}: removed`); } catch (e) { say('warn', `${label}: ${e.message}`); } };
  const gws = ((await get('/workload-principals/api/v1/virtual-mcp-servers')).data || []);
  for (const t of TEAMS) {
    const gw = gws.find((g) => g.profile.displayName === nm(t.gateway));
    const agent = ((await get('/workload-principals/api/v1/ai-agents')).data || []).find((a) => a.profile.name === nm(t.agent));
    if (gw) {
      const gwOrn = `orn:okta:directory:${orgIdOf(gw.orn)}:workload-principals:virtual-mcp:${gw.id}`;
      for (const l of (await get(`/workload-principals/api/v1/delegation-links?filter=${encodeURIComponent(`to.resourceOrn eq "${gwOrn}"`)}`)).data || []) {
        if (!agent || l.from.clientOrn.endsWith(`:${agent.id}`)) await del(`${nm(t.agent)} -> ${nm(t.gateway)} link`, () => api('DELETE', `/workload-principals/api/v1/delegation-links/${l.id}`));
      }
      for (const k of (await get(`/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/connections`)).data || []) {
        await del(`${nm(t.gateway)} connection`, async () => { await api('POST', `/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/connections/${k.id}/lifecycle/deactivate`, undefined, { allow: [400, 404, 409] }); await sleep(1500); await api('DELETE', `/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/connections/${k.id}`); });
      }
      await del(`${nm(t.gateway)} gateway`, async () => { await api('POST', `/workload-principals/api/v1/virtual-mcp-servers/${gw.id}/lifecycle/deactivate`, undefined, { allow: [400, 404, 409] }); await sleep(2500); await api('DELETE', `/workload-principals/api/v1/virtual-mcp-servers/${gw.id}`); });
    }
    if (agent) await del(`${nm(t.agent)}`, async () => { await api('POST', `/workload-principals/api/v1/ai-agents/${agent.id}/lifecycle/deactivate`, undefined, { allow: [400, 409] }); await sleep(2500); await api('DELETE', `/workload-principals/api/v1/ai-agents/${agent.id}`); });
  }
  for (const t of TEAMS) {
    const mcp = await findMcp(EXPECTED[t.key].mcp);
    if (mcp && !TAG) {
      const cs = await findCredentialSet(mcp.orn);
      if (cs) await del(`${mcp.metadata.displayName} credentials`, () => api('DELETE', `/resource-servers/api/v1/client-auth-settings/${cs.id}`));
      await del(`${mcp.metadata.displayName} MCP server record`, () => api('DELETE', `${mcpListPath}/${mcp.id}`));
    }
    // The STS client apps belong to the shared MCP server records, which a tagged rehearsal never creates, so it must never remove them.
    for (const label of [nm(t.agent), ...(TAG ? [] : [`${EXPECTED[t.key].mcp} STS Client`])]) {
      const apps = await get(`/api/v1/apps?q=${encodeURIComponent(label)}&limit=20`);
      for (const app of apps.filter((x) => x.label === label)) await del(`app ${label}`, async () => { await api('POST', `/api/v1/apps/${app.id}/lifecycle/deactivate`, undefined, { allow: [404] }); await api('DELETE', `/api/v1/apps/${app.id}`, undefined, { allow: [404] }); });
    }
    if (t.as) { const s = await findAuthServer(nm(t.as.name)); if (s) await del(`${nm(t.as.name)} authorization server`, async () => { await api('POST', `/api/v1/authorizationServers/${s.id}/lifecycle/deactivate`, undefined, { allow: [400] }); await api('DELETE', `/api/v1/authorizationServers/${s.id}`); }); }
    const u = await findUser(loginOf(t));
    if (u) await del(`user ${loginOf(t)}`, async () => { await api('POST', `/api/v1/users/${u.id}/lifecycle/deactivate`, undefined, { allow: [400] }); await api('DELETE', `/api/v1/users/${u.id}`); });
    const g = await findGroup(nm(t.group));
    if (g) await del(`${nm(t.group)} group`, () => api('DELETE', `/api/v1/groups/${g.id}`));
  }
}

// ---------- main ----------
async function main() {
  if (!['status', 'identity', 'connect', 'gateways', 'env', 'teardown'].includes(cmd)) {
    console.log('Usage: npm run okta -- <status | identity | connect --api-url <url> | gateways | env | teardown>   (add --tag <word> to rehearse beside an existing demo)');
    process.exit(cmd ? 2 : 0);
  }
  if (!base || !token) { console.error('Set OKTA_ORG_URL and OKTA_API_TOKEN (an SSWS token created by a super administrator) in .env or the environment.'); process.exit(2); }
  if (cmd === 'env') return printEnv();
  if (cmd === 'gateways') return printGateways();
  console.log(c(1, `\nOkta ${cmd}${TAG ? ` (tag "${TAG}")` : ''}${DRY ? ' (read only)' : ''} on ${base}`));
  if (cmd === 'teardown') await teardown();
  if (cmd === 'identity' || cmd === 'status') await identity();
  if (cmd === 'connect' || cmd === 'status') await connect();
  console.log(`\n${'─'.repeat(54)}`);
  console.log(tally.fail ? c(31, c(1, `${tally.fail} problem${tally.fail === 1 ? '' : 's'}: fix them and run the same command again`))
    : DRY ? (tally.warn ? c(33, `${tally.warn} item${tally.warn === 1 ? '' : 's'} still to create`) : c(32, c(1, 'Everything exists')))
      : c(32, c(1, 'Done')));
  if (state.users && Object.keys(state.users).length && cmd === 'identity' && !DRY) console.log(c(2, `  User passwords were saved to ${path.basename(STATE_FILE)} (gitignored). Keep that file private.`));
  process.exitCode = tally.fail ? 1 : 0;
}
main().catch((e) => { console.error(c(31, `\nFailed: ${String(e.message || e).slice(0, 400)}`)); process.exit(1); });
