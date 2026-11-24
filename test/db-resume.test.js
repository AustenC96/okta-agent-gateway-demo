import test from 'node:test';
import assert from 'node:assert/strict';
import { withResumeRetry, isResuming } from '../infra/mcp/core.mjs';

const resuming = () => Object.assign(new Error('Communications link failure: the database is resuming'), { name: 'DatabaseResumingException' });
const fast = { sleep: async () => {} };

test('a database that is resuming is retried until it answers', async () => {
  let calls = 0;
  const out = await withResumeRetry(async () => { if (++calls < 4) throw resuming(); return 'rows'; }, { ...fast, budgetMs: 60000 });
  assert.equal(out, 'rows');
  assert.equal(calls, 4);
});

test('it gives up when the time budget runs out, and passes the error on', async () => {
  let t = 0, calls = 0;
  await assert.rejects(withResumeRetry(async () => { calls++; throw resuming(); }, { sleep: async () => { t += 3000; }, now: () => t, budgetMs: 10000, delayMs: 3000 }), /resuming/);
  assert.ok(calls >= 3 && calls <= 5);
});

test('other errors are never retried', async () => {
  let calls = 0;
  await assert.rejects(withResumeRetry(async () => { calls++; throw new Error('syntax error at or near'); }, fast), /syntax/);
  assert.equal(calls, 1);
  assert.equal(isResuming(new Error('permission denied')), false);
});
