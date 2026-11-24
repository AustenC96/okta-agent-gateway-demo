import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';

for (const [name, make] of [['memory', () => createMemoryStore()]]) {
  test(`${name} store: events get increasing ids, list honours "after", sessions are separate`, async () => {
    const s = make();
    const a1 = await s.append('A', { label: 'one' }), a2 = await s.append('A', { label: 'two' }), b1 = await s.append('B', { label: 'other' });
    assert.deepEqual([a1.id, a2.id, b1.id], [1, 2, 1]);
    assert.deepEqual((await s.list('A')).map((e) => e.label), ['one', 'two']);
    assert.deepEqual((await s.list('A', 1)).map((e) => e.label), ['two']);
    assert.deepEqual((await s.list('A', 2)), []);
    assert.deepEqual((await s.list('B')).map((e) => e.label), ['other']);
    assert.deepEqual(await s.list('nobody'), []);
  });

  test(`${name} store: clear keeps numbering unless asked to reset it`, async () => {
    const s = make();
    await s.append('A', { n: 1 }); await s.append('A', { n: 2 });
    await s.clear('A'); assert.deepEqual(await s.list('A'), []);
    assert.equal((await s.append('A', { n: 3 })).id, 3, 'ids continue so a client’s "after" cursor stays valid');
    await s.clear('A', { resetSeq: true });
    assert.equal((await s.append('A', { n: 4 })).id, 1);
  });

  test(`${name} store: caps the trace at 500 events, newest kept`, async () => {
    const s = make();
    for (let i = 1; i <= 505; i++) await s.append('A', { i });
    const all = await s.list('A');
    assert.equal(all.length, 500); assert.equal(all[0].i, 6); assert.equal(all.at(-1).i, 505);
  });

  test(`${name} store: key/value put, take, drop; values are copies`, async () => {
    const s = make();
    const v = { exchange: { result: 'SUCCESS' } };
    await s.put('sts:A', v); v.exchange.result = 'mutated';
    assert.equal((await s.take('sts:A')).exchange.result, 'SUCCESS');
    assert.equal(await s.take('sts:B'), null);
    await s.drop('sts:A'); assert.equal(await s.take('sts:A'), null);
  });
}

test('memory store: keys and idle traces expire', async () => {
  let t = 1_000_000; const s = createMemoryStore({ now: () => t });
  await s.put('k', { a: 1 }, 10); t += 9_000; assert.deepEqual(await s.take('k'), { a: 1 }); t += 2_000; assert.equal(await s.take('k'), null);
});
