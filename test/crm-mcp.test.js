import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandler } from '../infra/mcp/crm.mjs';

// Offline: tokens are signed with a throwaway key, and the database is a stub that records what it was asked.
const ISSUER = 'https://example.oktapreview.com/oauth2/ausTEST', AUDIENCE = 'api://agw-demo-crm';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const sign = (claims, key = privateKey) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ iss: ISSUER, aud: AUDIENCE, exp: 2e9, sub: 'u@x', scp: ['crm:read'], ...claims })}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
};
function setup() {
  const calls = [];
  const db = async (sql, params) => { calls.push({ sql, params }); return [{ ok: true }]; };
  const handler = createHandler({ issuer: ISSUER, audience: AUDIENCE, getJwk: async () => jwk, db, now: () => 1e9, log: () => {} });
  const call = (body, token, extra = {}) => handler({
    requestContext: { http: { method: 'POST' }, domainName: 'fn.example.com' }, rawPath: '/',
    headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body), ...extra });
  return { calls, call, handler };
}
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('no token gets a 401 that points at the protected-resource metadata', async () => {
  const r = await setup().call(rpc('tools/list'));
  assert.equal(r.statusCode, 401);
  assert.match(r.headers['www-authenticate'], /resource_metadata="https:\/\/fn\.example\.com\/\.well-known\/oauth-protected-resource"/);
});

test('the metadata document is public and names the Okta authorization server', async () => {
  const r = await setup().handler({ requestContext: { http: { method: 'GET' }, domainName: 'fn.example.com' }, rawPath: '/.well-known/oauth-protected-resource', headers: {} });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body).authorization_servers, [ISSUER]);
});

test('tokens that are forged, for another audience, or expired are refused', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const token of [sign({}, other), sign({ aud: 'api://something-else' }), sign({ exp: 5 }), sign({ iss: 'https://evil.example.com' })]) {
    const r = await setup().call(rpc('tools/list'), token);
    assert.equal(r.statusCode, 401);
    assert.match(r.headers['www-authenticate'], /invalid_token/);
  }
});

test('a valid token lists all four tools and marks the write tool as not read-only', async () => {
  const r = await setup().call(rpc('tools/list'), sign({}));
  const tools = JSON.parse(r.body).result.tools;
  assert.equal(tools.length, 4);
  assert.equal(tools.find((t) => t.name === 'update_deal_stage').annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === 'get_customer').annotations.readOnlyHint, true);
});

test('crm:read can read, with the argument bound as a parameter and not pasted into the SQL', async () => {
  const s = setup();
  const r = await s.call(rpc('tools/call', { name: 'get_customer', arguments: { customer_id: "C-1001'; DROP TABLE crm.customers;--" } }), sign({}));
  assert.equal(JSON.parse(r.body).result.isError, undefined);
  assert.equal(s.calls.length, 1);
  assert.ok(!s.calls[0].sql.includes('DROP'));
  assert.equal(s.calls[0].params.id, "C-1001'; DROP TABLE crm.customers;--");
});

test('a read-only token cannot use the write tool and the database is never touched', async () => {
  const s = setup();
  const r = await s.call(rpc('tools/call', { name: 'update_deal_stage', arguments: { deal_id: 'D-5001', stage: 'Closed won' } }), sign({ scp: ['crm:read'] }));
  const res = JSON.parse(r.body).result;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /crm:write/);
  assert.equal(s.calls.length, 0);
});

test('a crm:write token can use the write tool, and an invalid stage is rejected', async () => {
  const s = setup();
  const ok = await s.call(rpc('tools/call', { name: 'update_deal_stage', arguments: { deal_id: 'D-5001', stage: 'Closed won' } }), sign({ scp: ['crm:read', 'crm:write'] }));
  assert.equal(JSON.parse(ok.body).result.isError, undefined);
  const bad = await s.call(rpc('tools/call', { name: 'update_deal_stage', arguments: { deal_id: 'D-5001', stage: 'Banana' } }), sign({ scp: ['crm:write'] }));
  assert.equal(JSON.parse(bad.body).result.isError, true);
});

test('a token with no CRM scopes can connect but cannot call any tool', async () => {
  const s = setup();
  const r = await s.call(rpc('tools/call', { name: 'list_deals', arguments: {} }), sign({ scp: ['openid'] }));
  assert.equal(JSON.parse(r.body).result.isError, true);
  assert.equal(s.calls.length, 0);
});

test('notifications get a 202, unknown tools and methods get JSON-RPC errors', async () => {
  const s = setup();
  assert.equal((await s.call({ jsonrpc: '2.0', method: 'notifications/initialized' }, sign({}))).statusCode, 202);
  assert.equal(JSON.parse((await s.call(rpc('tools/call', { name: 'nope' }), sign({}))).body).error.code, -32602);
  assert.equal(JSON.parse((await s.call(rpc('resources/list'), sign({}))).body).error.code, -32601);
});

test('mounted under a path, the metadata and the challenge use the RFC 9728 path-suffixed address', async () => {
  const handler = createHandler({ issuer: ISSUER, audience: AUDIENCE, mountPath: '/crm', getJwk: async () => jwk, db: async () => [], now: () => 1e9, log: () => {} });
  const ctx = (method) => ({ http: { method }, domainName: 'api.example.com' });
  const meta = await handler({ requestContext: ctx('GET'), rawPath: '/.well-known/oauth-protected-resource/crm', headers: {} });
  assert.equal(JSON.parse(meta.body).resource, 'https://api.example.com/crm');
  const noToken = await handler({ requestContext: ctx('POST'), rawPath: '/crm', headers: {}, body: '{}' });
  assert.equal(noToken.statusCode, 401);
  assert.match(noToken.headers['www-authenticate'], /resource_metadata="https:\/\/api\.example\.com\/\.well-known\/oauth-protected-resource\/crm"/);
  const list = await handler({ requestContext: ctx('POST'), rawPath: '/crm/', headers: { authorization: `Bearer ${sign({})}` }, body: JSON.stringify(rpc('tools/list')) });
  assert.equal(JSON.parse(list.body).result.tools.length, 4);
  // The MCP endpoint is only at the mount path, not at the host root or under another server's path.
  assert.equal((await handler({ requestContext: ctx('POST'), rawPath: '/', headers: {}, body: '{}' })).statusCode, 405);
  assert.equal((await handler({ requestContext: ctx('POST'), rawPath: '/hr', headers: {}, body: '{}' })).statusCode, 405);
});
