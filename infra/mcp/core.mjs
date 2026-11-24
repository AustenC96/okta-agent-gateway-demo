// Shared core for the demo MCP servers (CRM and HR): a minimal MCP "streamable HTTP" endpoint for AWS Lambda behind API Gateway,
// reading the demo database through the RDS Data API. It has no npm dependencies; the AWS SDK ships with the Lambda Node runtime.
//
// Every request must carry an Okta access token. The token is verified here (signature, issuer, audience, expiry), and then each
// tool checks the token's scopes. Okta decides who gets which scopes; this code enforces them.
// A server is defined by a name and a list of tools; see crm.mjs and hr.mjs.
import crypto from 'node:crypto';

const b64u = (s) => Buffer.from(s, 'base64url').toString('utf8');
const json = (status, body, headers = {}) => ({ statusCode: status, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });

// ---------- verifying the Okta access token ----------
// Okta signs access tokens with RS256 and publishes its public keys at <issuer>/v1/keys. Fetched keys are cached for ten minutes.
const keyCache = new Map();
export async function fetchJwk(issuer, kid) {
  const hit = keyCache.get(`${issuer}|${kid}`);
  if (hit && hit.until > Date.now()) return hit.jwk;
  const { keys } = await (await fetch(`${issuer}/v1/keys`)).json();
  for (const k of keys || []) keyCache.set(`${issuer}|${k.kid}`, { jwk: k, until: Date.now() + 600000 });
  return keyCache.get(`${issuer}|${kid}`)?.jwk;
}

export async function verifyJwt(token, { issuer, audience, getJwk, now }) {
  const [h, p, s] = String(token).split('.');
  if (!s) throw new Error('malformed token');
  const header = JSON.parse(b64u(h)), claims = JSON.parse(b64u(p));
  if (header.alg !== 'RS256') throw new Error('unsupported algorithm');
  const jwk = await getJwk(issuer, header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (claims.iss !== issuer) throw new Error('wrong issuer');
  if (![].concat(claims.aud || []).includes(audience)) throw new Error('wrong audience');
  if (!(claims.exp > now())) throw new Error('token expired');
  if (claims.nbf && claims.nbf > now() + 60) throw new Error('token not yet valid');
  return claims;
}

// ---------- the database (RDS Data API) ----------
// A paused Aurora Serverless database answers the first query with DatabaseResumingException and takes about 15 seconds to wake.
// Waiting for it here (within API Gateway's 30 second limit) turns a failed first call into a slow one. If it is still asleep
// when the budget runs out, the error is passed on and the tool reports "waking up" so the caller can simply try again.
export const isResuming = (e) => /DatabaseResuming|resuming/i.test(`${e?.name} ${e?.message}`);
export async function withResumeRetry(fn, { budgetMs = 24000, delayMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const deadline = now() + budgetMs;
  for (;;) {
    try { return await fn(); }
    catch (e) { if (!isResuming(e) || now() + delayMs > deadline) throw e; await sleep(delayMs); }
  }
}
// Parameters are always bound, never pasted into the SQL text, so tool arguments cannot inject SQL.
export function dataApiDb({ clusterArn, secretArn, database = 'postgres' }) {
  let client;
  return async (sql, params = {}) => {
    const { RDSDataClient, ExecuteStatementCommand } = await import('@aws-sdk/client-rds-data');
    client ||= new RDSDataClient({});
    const parameters = Object.entries(params).map(([name, v]) => ({ name, value: v == null ? { isNull: true } : { stringValue: String(v) } }));
    const out = await withResumeRetry(() => client.send(new ExecuteStatementCommand({ resourceArn: clusterArn, secretArn, database, sql, parameters, formatRecordsAs: 'JSON' })));
    return out.formattedRecords ? JSON.parse(out.formattedRecords) : [];
  };
}

const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

// ---------- the handler ----------
// Each tool is { name, scope, readOnly, description, inputSchema, run(args, db) }. mountPath is where this server lives on its host,
// such as '/crm' when API Gateway routes several MCP servers on one host ('' = host root).
export function createMcpHandler({ serverName, tools, issuer, audience, resourceUrl, mountPath = '', getJwk = fetchJwk, db, now = () => Date.now() / 1000, log = console.log }) {
  const scopesSupported = [...new Set(tools.map((t) => t.scope))];
  const mount = mountPath.replace(/\/+$/, '');
  return async (event) => {
    const http = event.requestContext?.http || {};
    const origin = resourceUrl ? resourceUrl.replace(/\/+$/, '') : `https://${event.requestContext?.domainName}`;
    const base = `${origin}${mount}`;
    // RFC 9728: for a resource at https://host/crm the metadata lives at https://host/.well-known/oauth-protected-resource/crm
    const metadataPath = `/.well-known/oauth-protected-resource${mount}`;
    const metadataUrl = `${origin}${metadataPath}`;
    const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';

    // Public: tells an MCP client which authorization server to get a token from.
    if (http.method === 'GET' && path === metadataPath) {
      return json(200, { resource: base, authorization_servers: [issuer], scopes_supported: scopesSupported, bearer_methods_supported: ['header'] });
    }
    if (http.method !== 'POST' || path !== (mount || '/')) return json(405, { error: `POST ${mount || '/'} only` }, { allow: 'POST' });

    const bearer = (event.headers?.authorization || '').match(/^Bearer (.+)$/i)?.[1];
    const challenge = (extra = '') => json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"${extra}` });
    if (!bearer) return challenge();
    let claims;
    try { claims = await verifyJwt(bearer, { issuer, audience, getJwk, now }); }
    catch (e) { log(JSON.stringify({ ev: 'auth-failed', reason: e.message })); return challenge(`, error="invalid_token"`); }
    const scopes = new Set([].concat(claims.scp || []).flatMap((s) => String(s).split(' ')));

    let rpc;
    try { rpc = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body || ''); }
    catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const reply = (result) => json(200, { jsonrpc: '2.0', id: rpc.id, result });
    const fail = (code, message) => json(200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });
    if (rpc.id === undefined) return { statusCode: 202, headers: {}, body: '' }; // a notification: nothing to answer

    const who = { sub: claims.sub, uid: claims.uid, scopes: [...scopes] };
    if (rpc.method === 'initialize') return reply({ protocolVersion: rpc.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: serverName, version: '1.0.0' } });
    if (rpc.method === 'ping') return reply({});
    if (rpc.method === 'tools/list') {
      log(JSON.stringify({ ev: 'mcp', method: 'tools/list', ...who }));
      return reply({ tools: tools.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, annotations: { readOnlyHint: !!readOnly } })) });
    }
    if (rpc.method === 'tools/call') {
      const tool = tools.find((t) => t.name === rpc.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${rpc.params?.name}`);
      const allowed = scopes.has(tool.scope);
      log(JSON.stringify({ ev: 'mcp', method: 'tools/call', tool: tool.name, needs: tool.scope, allowed, ...who }));
      if (!allowed) return reply(toolText(`Forbidden: ${tool.name} needs the ${tool.scope} scope, which this token does not carry.`, true));
      try { return reply(toolText(JSON.stringify(await tool.run(rpc.params.arguments || {}, db), null, 2))); }
      catch (e) {
        const waking = isResuming(e);
        log(JSON.stringify({ ev: 'tool-error', tool: tool.name, error: e.name, message: e.message }));
        return reply(toolText(waking ? 'The database is waking up from a pause. Try again in about 15 seconds.' : `Tool failed: ${e.message}`, true));
      }
    }
    return fail(-32601, `method not found: ${rpc.method}`);
  };
}

// Builds the Lambda entry point for one server. Settings come from environment variables so the same code works in any account.
export function lambdaEntry(serverName, tools) {
  let cached;
  return (event) => {
    cached ||= createMcpHandler({
      serverName, tools, issuer: process.env.OKTA_ISSUER, audience: process.env.AUDIENCE, resourceUrl: process.env.RESOURCE_URL, mountPath: process.env.MOUNT_PATH || '',
      db: dataApiDb({ clusterArn: process.env.DB_CLUSTER_ARN, secretArn: process.env.DB_SECRET_ARN, database: process.env.DB_NAME || 'postgres' }),
    });
    return cached(event);
  };
}
