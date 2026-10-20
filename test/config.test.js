import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv } from '../config.js';
import { fakeRedis } from './fakeRedis.js';

const SINGLE = { OKTA_ORG_URL: 'https://a.okta.com', GATEWAY_URL: 'https://g.example.com/mcp/x', CLIENT_ID: 'c', CLIENT_SECRET: 's' };
const MULTI = { DEMO_API_APP_ID: 'a', DEMO_API_CLIENT_ID: 'b', DEMO_API_CLIENT_SECRET: 'c', BASE_URI: 'https://demo.example.com/' };
const redisFactory = () => fakeRedis();

test('single-tenant: reads the org from the environment, streams, keeps state in memory, offers the log token', () => {
  const c = configFromEnv({ ...SINGLE, OKTA_API_TOKEN: 'tok', PORT: '9000' }, { redisFactory });
  assert.equal(c.orgUrl, 'https://a.okta.com'); assert.equal(c.logToken, 'tok'); assert.equal(c.transport, 'stream');
  assert.equal(c.store.kind, 'memory'); assert.equal(c.allowLocal, true); assert.equal(c.getTenant, undefined); assert.equal(c.hooks, undefined);
});

test('missing settings are named, for both modes', () => {
  assert.throws(() => configFromEnv({}, { redisFactory }), /Missing OKTA_ORG_URL/);
  assert.throws(() => configFromEnv({ ...MULTI, BASE_URI: '' }, { redisFactory }), /Missing BASE_URI/);
  assert.throws(() => configFromEnv({ DEMO_API_APP_ID: 'a' }, { redisFactory }), /Missing DEMO_API_CLIENT_ID/);
});

test('BASE_URI: trailing slash trimmed; paths, plain http on a public host and junk are refused', () => {
  assert.equal(configFromEnv({ ...MULTI }, { redisFactory }).origin, 'https://demo.example.com');
  for (const bad of ['http://demo.example.com', 'https://demo.example.com/app', 'https://demo.example.com/?x=1', 'nope']) assert.throws(() => configFromEnv({ ...MULTI, BASE_URI: bad }, { redisFactory }), /BASE_URI/, bad);
  assert.equal(configFromEnv({ ...SINGLE, BASE_URI: 'http://localhost:8080' }, { redisFactory }).allowLocal, true);
  assert.equal(configFromEnv({ ...MULTI }, { redisFactory }).allowLocal, false, 'a public https address turns the strict URL rules on');
});

test('multi-tenant: query by default, hooks wired, log token withheld, bad strategy refused', () => {
  const c = configFromEnv({ ...MULTI, OKTA_API_TOKEN: 'tok' }, { redisFactory });
  assert.deepEqual(c.resolution, { strategy: 'query', baseHost: 'demo.example.com' });
  assert.equal(typeof c.getTenant, 'function'); assert.ok(c.hooks); assert.equal(c.logToken, undefined);
  assert.throws(() => configFromEnv({ ...MULTI, RESOLUTION_STRATEGY: 'path' }, { redisFactory }), /RESOLUTION_STRATEGY/);
});

test('Vercel: needs Redis and a session secret, then polls and uses the Redis store', () => {
  const v = { ...MULTI, VERCEL: '1' };
  assert.throws(() => configFromEnv({ ...v, SESSION_SECRET: 'x' }, { redisFactory }), /Redis/);
  assert.throws(() => configFromEnv({ ...v, UPSTASH_REDIS_REST_URL: 'https://r', UPSTASH_REDIS_REST_TOKEN: 't' }, { redisFactory }), /SESSION_SECRET/);
  const c = configFromEnv({ ...v, SESSION_SECRET: 'x', UPSTASH_REDIS_REST_URL: 'https://r', UPSTASH_REDIS_REST_TOKEN: 't' }, { redisFactory });
  assert.equal(c.transport, 'poll'); assert.equal(c.store.kind, 'redis');
  const m = configFromEnv({ ...v, SESSION_SECRET: 'x', KV_REST_API_URL: 'https://r', KV_REST_API_TOKEN: 't' }, { redisFactory });
  assert.equal(m.store.kind, 'redis', 'the Vercel marketplace variable names work too');
});

test('trust proxy: a hop count becomes a number, anything else stays text', () => {
  assert.equal(configFromEnv({ ...SINGLE, TRUST_PROXY: '1' }, { redisFactory }).trustProxy, 1);
  assert.equal(configFromEnv({ ...SINGLE, TRUST_PROXY: 'loopback' }, { redisFactory }).trustProxy, 'loopback');
  assert.equal(configFromEnv({ ...SINGLE }, { redisFactory }).trustProxy, undefined);
  // On Vercel, TLS ends in front of the function; without trusting that hop the secure session cookie is never set.
  const onVercel = { ...SINGLE, VERCEL: '1', SESSION_SECRET: 'x', KV_REST_API_URL: 'https://r', KV_REST_API_TOKEN: 't' };
  assert.equal(configFromEnv(onVercel, { redisFactory }).trustProxy, 1);
  assert.equal(configFromEnv({ ...onVercel, TRUST_PROXY: '2' }, { redisFactory }).trustProxy, 2, 'an explicit setting still wins');
});
