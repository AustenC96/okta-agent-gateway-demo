import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, browser } from './helpers.js';

// The governance check sends a real call for a tool the admin did not expose, so its guards matter more than its happy path.
const post = (fetchAs, body) => fetchAs('/api/mcp/blocked', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('governance check refuses any tool outside its two-item list', async () => {
  const app = await startApp();
  try {
    const r = await post(browser(app.base), { tool: 'get_me' });
    assert.equal(r.status, 400);
  } finally { await app.close(); }
});

test('governance check refuses until the gateway tool list has been read', async () => {
  const app = await startApp();
  try {
    const r = await post(browser(app.base), { tool: 'GitHubMCP_merge_pull_request' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /List the gateway/);
  } finally { await app.close(); }
});
