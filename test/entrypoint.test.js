import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

// Boots the real entry point (npm start) in a child process, the way it runs for real, and waits for it to listen.
function boot(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd: mkdtempSync(path.join(tmpdir(), 'agw-')), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const done = (up) => { clearTimeout(timer); resolve({ up, out, stop: () => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill(); }) }); };
    const timer = setTimeout(() => done(false), 4000);
    child.stdout.on('data', (d) => { out += d; if (/listening|running/.test(out)) done(true); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => done(false));
  });
}
const ENV = { OKTA_ORG_URL: 'https://example.oktapreview.com', GATEWAY_URL: 'https://example.gateway.oktapreview.com/mcp/servers/t', CLIENT_ID: 'c', CLIENT_SECRET: 's' };
const MULTI = { DEMO_API_APP_ID: 'a', DEMO_API_CLIENT_ID: 'b', DEMO_API_CLIENT_SECRET: 'c', BASE_URI: 'https://demo.example.com' };

test('entry point starts in single-tenant mode', async () => {
  const p = await boot({ ...ENV, PORT: '0' }); try { assert.ok(p.up, p.out); } finally { await p.stop(); }
});

test('entry point starts in multi-tenant mode (all modules wired up)', async () => {
  const p = await boot({ ...MULTI, PORT: '0' }); try { assert.ok(p.up, p.out); assert.doesNotMatch(p.out, /ReferenceError|is not defined/); } finally { await p.stop(); }
});

test('entry point refuses to start without its settings', async () => {
  const p = await boot({ PORT: '0' });
  const q = await boot({ ...MULTI, BASE_URI: '', PORT: '0' });
  try {
    assert.equal(p.up, false); assert.match(p.out, /Missing OKTA_ORG_URL/);
    assert.equal(q.up, false); assert.match(q.out, /Missing BASE_URI/);
  } finally { await p.stop(); await q.stop(); }
});
