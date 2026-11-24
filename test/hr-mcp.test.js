import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandler } from '../infra/mcp/hr.mjs';

// Offline, like the CRM tests: throwaway signing key, stub database.
const ISSUER = 'https://example.oktapreview.com/oauth2/ausHR', AUDIENCE = 'api://agw-demo-hr';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const sign = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ iss: ISSUER, aud: AUDIENCE, exp: 2e9, sub: 'hannah', scp: ['hr:read'], ...claims })}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), privateKey).toString('base64url')}`;
};
function setup() {
  const calls = [];
  const handler = createHandler({ issuer: ISSUER, audience: AUDIENCE, mountPath: '/hr', getJwk: async () => jwk, db: async (sql, params) => { calls.push({ sql, params }); return []; }, now: () => 1e9, log: () => {} });
  const call = (method, params, token) => handler({ requestContext: { http: { method: 'POST' }, domainName: 'api.example.com' }, rawPath: '/hr',
    headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { calls, call, handler };
}
const result = (r) => JSON.parse(r.body).result;

test('HR metadata advertises the HR scopes and the HR path', async () => {
  const r = await setup().handler({ requestContext: { http: { method: 'GET' }, domainName: 'api.example.com' }, rawPath: '/.well-known/oauth-protected-resource/hr', headers: {} });
  const doc = JSON.parse(r.body);
  assert.deepEqual(doc.scopes_supported, ['hr:read', 'hr:sensitive']);
  assert.equal(doc.resource, 'https://api.example.com/hr');
});

test('the server identifies itself as the HR server and lists three tools', async () => {
  const s = setup();
  assert.equal(result(await s.call('initialize', {}, sign({}))).serverInfo.name, 'agw-demo-hr');
  const tools = result(await s.call('tools/list', {}, sign({}))).tools;
  assert.deepEqual(tools.map((t) => t.name), ['list_employees', 'get_employee', 'get_compensation']);
});

test('hr:read reads the directory but is refused on compensation, without touching the database', async () => {
  const s = setup();
  const dir = result(await s.call('tools/call', { name: 'list_employees', arguments: { department: 'Sales' } }, sign({})));
  assert.equal(dir.isError, undefined);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].params.dept, 'Sales');
  const pay = result(await s.call('tools/call', { name: 'get_compensation', arguments: { employee_id: 'E-2003' } }, sign({})));
  assert.equal(pay.isError, true);
  assert.match(pay.content[0].text, /hr:sensitive/);
  assert.equal(s.calls.length, 1);
});

test('hr:sensitive can read compensation', async () => {
  const s = setup();
  const pay = result(await s.call('tools/call', { name: 'get_compensation', arguments: { employee_id: 'E-2003' } }, sign({ scp: ['hr:read', 'hr:sensitive'] })));
  assert.equal(pay.isError, undefined);
  assert.equal(s.calls.length, 1);
});

test('a CRM token is useless here: wrong audience, and CRM scopes grant nothing', async () => {
  const s = setup();
  assert.equal((await s.call('tools/list', {}, sign({ aud: 'api://agw-demo-crm' }))).statusCode, 401);
  const r = result(await s.call('tools/call', { name: 'list_employees', arguments: {} }, sign({ scp: ['crm:read', 'crm:write'] })));
  assert.equal(r.isError, true);
  assert.equal(s.calls.length, 0);
});
