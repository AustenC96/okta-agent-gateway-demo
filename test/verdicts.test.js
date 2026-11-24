import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyTool, callVerdict, blockedVerdict, probeVerdict } from '../verdicts.js';

const ok = (text) => ({ result: { content: [{ type: 'text', text }] } });

test('tool names read like words', () => {
  assert.equal(friendlyTool('CRMMCP_search_customers'), 'Search customers');
  assert.equal(friendlyTool('GitHubMCP_get_me'), 'Get me');
  assert.equal(friendlyTool('plain_name'), 'Plain name');
});

test('a normal result is Allowed', () => {
  const v = callVerdict({ name: 'CRMMCP_get_customer', status: 200, parsed: ok('{"name":"Northwind"}') });
  assert.equal(v.kind, 'allowed');
  assert.match(v.detail, /Get customer/);
});

test('a consent link beats everything else, even inside a successful HTTP response', () => {
  const v = callVerdict({ name: 'GitHubMCP_get_me', status: 200, parsed: { result: { isError: true, content: [{ type: 'text', text: 'Connection required' }] } }, consentUrl: 'https://org/oauth2/v1/sts/redirect?dataHandle=x' });
  assert.equal(v.kind, 'consent');
  assert.equal(v.url, 'https://org/oauth2/v1/sts/redirect?dataHandle=x');
});

test('a missing scope is attributed to the MCP server, other tool errors are just problems', () => {
  const forbidden = callVerdict({ name: 'HRMCP_get_compensation', status: 200, parsed: { result: { isError: true, content: [{ type: 'text', text: 'Forbidden: get_compensation needs the hr:sensitive scope.' }] } } });
  assert.equal(forbidden.kind, 'blocked-server');
  const other = callVerdict({ name: 'CRMMCP_get_customer', status: 200, parsed: { result: { isError: true, content: [{ type: 'text', text: 'Tool failed: boom' }] } } });
  assert.equal(other.kind, 'problem');
});

test('transport failures and protocol errors are problems', () => {
  assert.equal(callVerdict({ name: 'x', status: 502 }).kind, 'problem');
  assert.equal(callVerdict({ name: 'x', error: 'ECONNRESET' }).kind, 'problem');
  assert.equal(callVerdict({ name: 'x', status: 200, parsed: { error: { code: -32602, message: 'invalid params' } } }).kind, 'problem');
});

test('asking for a tool the gateway does not list is Blocked by the gateway, and a non-refusal is flagged', () => {
  const blocked = blockedVerdict({ name: 'HRMCP_get_compensation', gatewayLabel: 'Sales Tools', refused: true });
  assert.equal(blocked.kind, 'blocked-gateway');
  assert.match(blocked.detail, /Get compensation.*Sales Tools/);
  assert.equal(blockedVerdict({ name: 'x', refused: false }).kind, 'problem');
});

test('another team’s agent: refused is Blocked by Okta, success is flagged as unexpected', () => {
  const target = { agent: 'Engineering Agent', gateway: 'Engineering Tools', resource: 'GitHub' };
  const v = probeVerdict({ person: 'Sofia Reyes', agent: 'Engineering Agent', refused: true, target });
  assert.equal(v.kind, 'blocked-okta');
  assert.deepEqual(v.target, target);
  assert.equal(probeVerdict({ person: 'Sofia Reyes', agent: 'Engineering Agent', refused: false }).kind, 'problem');
});

test('a sleeping database is a calm "waking up" state, not an error', () => {
  const v = callVerdict({ name: 'CRMMCP_search_customers', status: 200, parsed: { result: { isError: true, content: [{ type: 'text', text: 'The database is waking up from a pause. Try again in about 15 seconds.' }] } } });
  assert.equal(v.kind, 'waking');
  assert.match(v.detail, /again/);
});
