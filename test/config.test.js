import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv } from '../config.js';

const SINGLE = { OKTA_ORG_URL: 'https://a.okta.com', GATEWAY_URL: 'https://g.example.com/mcp/servers/eng', CLIENT_ID: 'c', CLIENT_SECRET: 's' };

test('a plain setup: memory store, local rules, a log token if one is given, and the three personas', () => {
  const c = configFromEnv({ ...SINGLE, OKTA_API_TOKEN: 'tok', PORT: '9000' });
  assert.equal(c.port, '9000');
  assert.equal(c.store.kind, 'memory');
  assert.equal(c.allowLocal, true);
  assert.equal(c.logToken, 'tok');
  assert.equal(c.transport, 'stream');
  assert.equal(c.personas.length, 3);
});

test('missing settings are named in the error', () => {
  assert.throws(() => configFromEnv({}), /Missing OKTA_ORG_URL/);
  assert.throws(() => configFromEnv({ ...SINGLE, CLIENT_SECRET: undefined }), /Missing CLIENT_SECRET/);
});

test('a client whose ID is a URL is public: no secret is needed, and a secret is not invented', () => {
  const c = configFromEnv({ ...SINGLE, CLIENT_ID: 'https://claude.ai/oauth/claude-code-client-metadata', CLIENT_SECRET: undefined, CALLBACK_PATH: '/callback' });
  assert.equal(c.clientSecret, undefined);
  assert.equal(c.callbackPath, '/callback');
});

test('BASE_URI: trailing slash trimmed; paths, plain http on a public host and junk are refused', () => {
  assert.equal(configFromEnv({ ...SINGLE, BASE_URI: 'https://demo.example.com/' }).origin, 'https://demo.example.com');
  for (const bad of ['http://demo.example.com', 'https://demo.example.com/app', 'https://demo.example.com/?x=1', 'nope']) assert.throws(() => configFromEnv({ ...SINGLE, BASE_URI: bad }), /BASE_URI/, bad);
  assert.equal(configFromEnv({ ...SINGLE, BASE_URI: 'http://localhost:8080' }).allowLocal, true);
  assert.equal(configFromEnv({ ...SINGLE, BASE_URI: 'https://demo.example.com' }).allowLocal, false, 'a public https address turns the strict URL rules on');
});

test('TRUST_PROXY accepts a hop count or a name, and is off by default', () => {
  assert.equal(configFromEnv({ ...SINGLE, TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(configFromEnv({ ...SINGLE, TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(configFromEnv({ ...SINGLE }).trustProxy, undefined);
});
