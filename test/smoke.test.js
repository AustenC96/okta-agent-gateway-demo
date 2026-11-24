import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, browser } from './helpers.js';
import { stsStatus } from '../server.js';

test('config endpoint answers and sets a session cookie', async () => {
  const app = await startApp();
  try {
    const res = await fetch(app.base + '/api/config');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /connect\.sid=/);
    const body = await res.json();
    assert.equal(body.signedIn, false);
    assert.equal(body.gatewayUrl, 'https://example.gateway.oktapreview.com/mcp/servers/test');
  } finally { await app.close(); }
});

test('login is refused until discovery has run', async () => {
  const app = await startApp();
  try {
    const res = await browser(app.base)('/auth/login');
    assert.equal(res.status, 409);
  } finally { await app.close(); }
});

test('flow endpoint reports every node as idle for a new session', async () => {
  const app = await startApp();
  try {
    const { nodes } = await (await browser(app.base)('/api/flow')).json();
    assert.equal(Object.keys(nodes).length, 9);
    for (const n of Object.values(nodes)) assert.equal(n.status, 'idle');
  } finally { await app.close(); }
});

test('two app instances do not share state', async () => {
  const a = await startApp(), b = await startApp();
  try {
    const cfgA = await (await fetch(a.base + '/api/config')).json();
    const cfgB = await (await fetch(b.base + '/api/config')).json();
    assert.deepEqual(cfgA, cfgB);
  } finally { await a.close(); await b.close(); }
});

test('stsStatus', () => {
  assert.equal(stsStatus({ sts: null, consentUrl: 'x', callOk: true }), 'waiting');
  assert.equal(stsStatus({ sts: { exchange: { result: 'SUCCESS' } }, callOk: true }), 'done');
  assert.equal(stsStatus({ sts: { exchange: { result: 'DENY' } }, callOk: true }), 'error');
  assert.equal(stsStatus({ sts: { reused: true }, callOk: true }), 'done');
  assert.equal(stsStatus({ sts: null, callOk: true }), 'inferred');
  assert.equal(stsStatus({ sts: null, callOk: false }), 'idle');
});
