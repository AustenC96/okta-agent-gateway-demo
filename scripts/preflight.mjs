// Pre-flight for a customer session:  npm run preflight
//
// 1. Checks that Okta, AWS and the app's own settings are exactly as the demo needs them.
// 2. Wakes Aurora and checks the tables both MCP servers read (so no later call is slow or hits a missing table).
// 3. Puts the fictional CRM deals back to their seeded stages, in case a rehearsal changed one.
// 4. Starts the app fresh (stopping any old copy), so every session and trace is empty.
//
// It only reads from Okta and AWS. The only things it writes are the database wake-up and the deal stages. It never prints a secret.
//   npm run preflight             everything above
//   npm run preflight -- --check  look but change nothing, and do not (re)start the app
//   npm run preflight -- --no-start   do everything except start the app
import { spawn, execFileSync, execSync } from 'node:child_process';
import { readFileSync, openSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { personasFromEnv } from '../personas.js';
import { EXPECTED, parseSeed, dealDrift, evaluateOkta, consentReport, awakeUntil } from './preflight-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const ARGS = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGS.has('--check'), NO_START = ARGS.has('--no-start') || CHECK_ONLY;
const env = process.env;
const REGION = env.AWS_REGION || 'us-east-1';
const PORT = Number(env.PORT) || 8080;
const LOG = '/tmp/agent-gateway-demo.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- output ----------
const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const ICON = { ok: c(32, '✓'), warn: c(33, '!'), fail: c(31, '✗'), info: c(36, '·') };
const tally = { ok: 0, warn: 0, fail: 0 };
const say = (level, text, detail) => { tally[level] = (tally[level] || 0) + 1; console.log(`  ${ICON[level]} ${text}${detail ? c(2, `  ${detail}`) : ''}`); };
const head = (t) => console.log(`\n${c(1, t)}`);
const errText = (e) => String(e?.stderr || e?.message || e).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 220);

// ---------- Okta (read only) ----------
const base = (env.OKTA_ORG_URL || '').replace(/\/+$/, '');
const token = env.OKTA_API_TOKEN || env.OKTA_AGENTGATEWAY_API_TOKEN;
async function okta(p) {
  const r = await fetch(base + p, { headers: { Authorization: `SSWS ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p.split('?')[0]} → HTTP ${r.status} ${body?.errorSummary || ''}`.trim());
  return body;
}
async function readOkta() {
  const groups = Object.fromEntries((await okta('/api/v1/groups?limit=200')).map((g) => [g.id, g.profile.name]));
  const users = (await okta('/api/v1/users?limit=200')).map((u) => ({ id: u.id, login: u.profile.login, status: u.status }));
  const agents = [];
  for (const a of (await okta('/workload-principals/api/v1/ai-agents')).data) {
    const app = a.signOnProvider?.appInstanceId;
    const info = app ? await okta(`/api/v1/apps/${app}`) : null;
    const appGroups = app ? (await okta(`/api/v1/apps/${app}/groups`)).map((x) => groups[x.id] || x.id) : [];
    agents.push({ id: a.id, name: a.profile.name, status: a.status, appStatus: info?.status, appGroups });
  }
  const gateways = [];
  for (const w of (await okta('/workload-principals/api/v1/virtual-mcp-servers')).data) {
    const connections = [];
    for (const k of (await okta(`/workload-principals/api/v1/virtual-mcp-servers/${w.id}/connections`)).data || []) {
      const caps = (await okta(`/workload-principals/api/v1/virtual-mcp-servers/${w.id}/connections/${k.id}/capabilities`)).data || [];
      connections.push({ resource: k.resource?.name, status: k.status, tools: caps.map((q) => ({ name: q.profile?.alias, status: q.status })) });
    }
    const links = (await okta(`/workload-principals/api/v1/delegation-links?filter=${encodeURIComponent(`to.resourceOrn eq "${w.orn.replace('oktapreview', 'okta')}"`)}`)).data || [];
    gateways.push({ name: w.profile.displayName, status: w.status, path: null, connections, linkedAgentIds: links.map((l) => l.from.clientOrn.split(':').pop()) });
  }
  const mcpServers = ((await okta('/resource-servers/api/v1/mcp-servers?limit=50')).data || []).map((m) => ({ name: m.metadata?.displayName, status: m.status }));
  return { users, agents, gateways, mcpServers };
}
async function latestConsents() {
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const ev = await okta(`/api/v1/logs?limit=200&sortOrder=DESCENDING&since=${since}&filter=${encodeURIComponent('eventType eq "app.oauth2.token.oauth_sts.request_token"')}`);
  const m = new Map();
  for (const e of ev) { const k = e.actor?.alternateId?.toLowerCase(); if (k && !m.has(k)) m.set(k, e.published); }
  return m;
}

// ---------- AWS ----------
const CLUSTER_ID = env.DB_CLUSTER_ID || 'demo-db';
const aws = (args) => JSON.parse(execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 45000 }) || 'null');
async function sql(statement) {
  const out = execFileSync('aws', ['rds-data', 'execute-statement', '--region', REGION, '--resource-arn', env.DB_CLUSTER_ARN, '--secret-arn', env.DB_SECRET_ARN, '--database', env.DB_NAME || 'postgres',
    '--sql', statement, '--format-records-as', 'JSON', '--output', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 });
  const j = JSON.parse(out);
  return j.formattedRecords ? JSON.parse(j.formattedRecords) : [];
}
async function sqlRetry(statement, { tries = 14, wait = 4000 } = {}) {
  for (let i = 1; ; i++) {
    try { return await sql(statement); }
    catch (e) { if (!/resum/i.test(errText(e)) || i >= tries) throw e; process.stdout.write(c(2, `    waking up… (${i})\n`)); await sleep(wait); }
  }
}

// ---------- the app ----------
const appUp = async () => { try { return (await fetch(`http://localhost:${PORT}/api/transport`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
function stopOldApp() {
  let pids = '';
  try { pids = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' }).trim(); } catch { return 0; }
  const list = pids.split('\n').filter(Boolean);
  // Only stop a process that is this very app, never something else that happens to use the port.
  const mine = list.filter((pid) => { try { return /server\.js/.test(execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' })); } catch { return false; } });
  for (const pid of mine) process.kill(Number(pid), 'SIGTERM');
  return { stopped: mine.length, foreign: list.length - mine.length };
}

async function main() {
  console.log(c(1, `\nPre-flight${CHECK_ONLY ? ' (check only: nothing will be changed)' : ''}`));
  const personas = personasFromEnv(env);
  const seed = parseSeed(readFileSync(path.join(ROOT, 'infra/db/02-seed.sql'), 'utf8'));

  // ----- 1. settings
  head('1. This computer');
  for (const [k, label] of [['OKTA_ORG_URL', 'Okta org'], ['GATEWAY_URL', 'Engineering gateway URL'], ['CLIENT_ID', 'Engineering agent client'], ['DB_CLUSTER_ARN', 'Database cluster'], ['DB_SECRET_ARN', 'Database secret']]) {
    env[k] ? say('ok', `${label} is set`) : say('fail', `${label} (${k}) is not set`);
  }
  token ? say('ok', 'Okta API token is set (the token-exchange evidence will turn green)') : say('warn', 'No Okta API token: the log-evidence stages will show "inferred" and this check cannot read Okta');
  for (const p of personas) p.configured ? say('ok', `${p.name}: agent client details are set`) : say('fail', `${p.name}: agent client ID or secret is missing (${p.agent})`);
  try { execFileSync('aws', ['sts', 'get-caller-identity', '--region', REGION, '--output', 'json'], { stdio: 'pipe', timeout: 20000 }); say('ok', 'AWS sign-in is valid'); }
  catch { say('fail', 'AWS sign-in has expired', 'run:  aws sso login'); }

  // ----- 2. Okta
  head('2. Okta');
  if (!token || !base) say('fail', 'Cannot check Okta without OKTA_ORG_URL and an API token');
  else {
    try {
      const data = await readOkta();
      const findings = evaluateOkta(data, personas);
      for (const f of findings) {
        if (f.fix?.type === 'unlock' && !CHECK_ONLY) {
          try {
            await fetch(`${base}/api/v1/users/${f.fix.id}/lifecycle/unlock`, { method: 'POST', headers: { Authorization: `SSWS ${token}`, Accept: 'application/json' } });
            say('ok', `${f.fix.name}: was locked out, unlocked`);
            continue;
          } catch { /* fall through and report it */ }
        }
        say(f.level, f.text);
      }
      const consent = consentReport(personas, await latestConsents());
      for (const x of consent) {
        x.at ? say('ok', `${x.name}: has consented to the downstream service`, `last on ${x.at.slice(0, 10)}`)
             : say('warn', `${x.name}: no consent on record, so the first tool call will ask for a one-time consent link`);
      }
    } catch (e) { say('fail', `Could not read Okta: ${errText(e)}`); }
  }

  // ----- 3. the cloud
  head('3. AWS');
  let reachable = false;
  try {
    const cl = aws(['rds', 'describe-db-clusters', '--db-cluster-identifier', CLUSTER_ID]).DBClusters[0];
    const sc = cl.ServerlessV2ScalingConfiguration || {};
    cl.Status === 'available' ? say('ok', `Aurora cluster ${CLUSTER_ID} is available`) : say('fail', `Aurora cluster ${CLUSTER_ID} is ${cl.Status}`);
    cl.HttpEndpointEnabled ? say('ok', 'RDS Data API is on') : say('fail', 'RDS Data API is off, so both MCP servers cannot reach the database');
    reachable = cl.Status === 'available' && cl.HttpEndpointEnabled;
    var autoPause = { minCapacity: sc.MinCapacity, autoPauseSeconds: sc.SecondsUntilAutoPause };
  } catch (e) { say('fail', `Could not read the Aurora cluster: ${errText(e)}`); }
  for (const fn of ['agw-demo-crm-mcp', 'agw-demo-hr-mcp']) {
    try {
      const f = aws(['lambda', 'get-function-configuration', '--function-name', fn]);
      f.State === 'Active' && f.LastUpdateStatus === 'Successful' ? say('ok', `${fn} is deployed and active`) : say('fail', `${fn} is ${f.State}/${f.LastUpdateStatus}`);
    } catch (e) { say('fail', `${fn}: ${errText(e)}`); }
  }
  // The three team agents on AgentCore: each person's chat needs their runtime to exist and be READY.
  for (const [key, who] of [['ENGINEERING_AGENT_RUNTIME_ARN', 'Engineering'], ['SALES_AGENT_RUNTIME_ARN', 'Sales'], ['HR_AGENT_RUNTIME_ARN', 'HR']]) {
    const arn = env[key];
    if (!arn) { say('warn', `${who} agent runtime (${key}) is not set, so that person has no chat`); continue; }
    try {
      const r = aws(['bedrock-agentcore-control', 'get-agent-runtime', '--agent-runtime-id', arn.split('/').pop()]);
      r.status === 'READY' ? say('ok', `${who} agent runtime is ready`) : say('fail', `${who} agent runtime is ${r.status}`);
    } catch (e) { say('fail', `${who} agent runtime: ${errText(e)}`); }
  }
  // The public face of each MCP server: reachable, and refusing anonymous callers the right way.
  const apiBase = (env.MCP_API_BASE || '').replace(/\/+$/, '');
  if (!apiBase) say('fail', 'MCP_API_BASE is not set, so the two MCP servers cannot be checked', 'it is the McpApiUrl output of the AWS stack');
  else for (const p of ['crm', 'hr']) {
    try {
      const m = await fetch(`${apiBase}/.well-known/oauth-protected-resource/${p}`, { signal: AbortSignal.timeout(15000) });
      const a = await fetch(`${apiBase}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
      m.status === 200 && a.status === 401 && a.headers.get('www-authenticate') ? say('ok', `/${p} answers publicly and refuses anonymous callers correctly`) : say('fail', `/${p} on API Gateway misbehaves (metadata ${m.status}, anonymous call ${a.status})`);
    } catch (e) { say('fail', `/${p} on API Gateway is unreachable: ${errText(e)}`); }
  }

  // ----- 4. wake the database, prove both servers can read it, restore the data
  head('4. Database');
  if (CHECK_ONLY) say('info', 'Skipped (check only): the database is not woken and the data is not touched');
  else if (!reachable || !env.DB_CLUSTER_ARN || !env.DB_SECRET_ARN) say('fail', 'Skipped: the database cannot be reached (see above)');
  else {
    try {
      const t0 = Date.now();
      await sqlRetry('SELECT 1');
      say('ok', `Database is awake`, `${Math.round((Date.now() - t0) / 1000)}s`);
      // The exact queries each MCP server runs, so a missing table or permission shows up now and not on stage.
      const probes = [['CRM', 'SELECT count(*) AS n FROM crm.customers', seed.counts.customers], ['CRM', 'SELECT count(*) AS n FROM crm.deals', seed.counts.deals],
        ['HR', 'SELECT count(*) AS n FROM hr.employees', seed.counts.employees], ['HR', 'SELECT count(*) AS n FROM hr.compensation', seed.counts.compensation]];
      for (const [who, q, want] of probes) {
        const n = Number((await sql(q))[0]?.n);
        const table = q.split('FROM ')[1];
        n === want ? say('ok', `${who} data: ${table} has ${n} rows`) : say('fail', `${who} data: ${table} has ${n} rows but the seed has ${want}`, 'reload with:  npm run seed -- --reset');
      }
      const drift = dealDrift(seed.deals, await sql('SELECT deal_id, stage FROM crm.deals'));
      if (drift.missing.length || drift.extra.length) say('fail', `Deals do not match the seed (missing ${drift.missing.join(', ') || 'none'}, extra ${drift.extra.join(', ') || 'none'})`, 'reload with:  npm run seed -- --reset');
      else if (drift.changed.length) {
        for (const d of drift.changed) await sql(`UPDATE crm.deals SET stage = '${d.to.replace(/'/g, "''")}' WHERE deal_id = '${d.id.replace(/'/g, "''")}'`);
        say('warn', `Restored ${drift.changed.length} deal stage${drift.changed.length === 1 ? '' : 's'} to the seeded values`, drift.changed.map((d) => `${d.id}: ${d.from}→${d.to}`).join(', '));
      } else say('ok', 'Deal stages are exactly as seeded');
    } catch (e) { say('fail', `Database check failed: ${errText(e)}`); }
  }

  // ----- 5. the app
  head('5. The app');
  if (NO_START) say('info', CHECK_ONLY ? 'Skipped (check only)' : 'Not started (--no-start)');
  else if (tally.fail) say('fail', 'Not started: fix the problems above first, then run this again');
  else {
    const old = stopOldApp();
    if (old.stopped) { say('ok', `Stopped the previous copy of the app`, 'all old sessions and traces are gone'); await sleep(800); }
    if (old.foreign) say('fail', `Port ${PORT} is used by another program, so the app cannot start`, `find it with:  lsof -i :${PORT}`);
    else {
      const out = openSync(LOG, 'w');
      const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...env, OKTA_API_TOKEN: token } });
      child.unref();
      let up = false;
      for (let i = 0; i < 20 && !up; i++) { await sleep(500); up = await appUp(); }
      if (!up) say('fail', 'The app did not start', `see ${LOG}`);
      else {
        say('ok', `App is running at http://localhost:${PORT}`, `log: ${LOG}`);
        const cfg = await (await fetch(`http://localhost:${PORT}/api/config`)).json();
        say(cfg.personas?.length === 3 && cfg.personas.every((p) => p.configured) ? 'ok' : 'fail', 'All three personas are ready on the picker');
        say(!cfg.signedIn && !cfg.persona ? 'ok' : 'warn', 'It starts on the picker with an empty trace');
      }
    }
  }

  // ----- verdict
  const bar = '─'.repeat(54);
  console.log(`\n${bar}`);
  if (tally.fail) {
    console.log(c(31, c(1, `NOT READY: ${tally.fail} problem${tally.fail === 1 ? '' : 's'} to fix`)) + (tally.warn ? `, ${tally.warn} note${tally.warn === 1 ? '' : 's'}` : ''));
  } else {
    console.log(c(32, c(1, CHECK_ONLY ? 'LOOKS GOOD (nothing was changed)' : 'READY')) + (tally.warn ? `  (${tally.warn} note${tally.warn === 1 ? '' : 's'} above)` : ''));
    if (!CHECK_ONLY && !NO_START) console.log(`\n  Open http://localhost:${PORT} and pick someone.`);
    const until = typeof autoPause === 'object' ? awakeUntil(autoPause) : null;
    if (!CHECK_ONLY && until) console.log(`  The database stays awake until about ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} if left idle. Run this again if you start later.`);
  }
  console.log(bar);
  process.exitCode = tally.fail ? 1 : 0;
}
main().catch((e) => { console.error(c(31, `\nPre-flight crashed: ${errText(e)}`)); process.exit(2); });
