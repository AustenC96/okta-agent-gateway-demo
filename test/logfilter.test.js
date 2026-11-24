import test from 'node:test';
import assert from 'node:assert/strict';
import { isMine } from '../server.js';

const exchange = (user, userId) => ({ eventType: 'app.oauth2.token.grant.oauth_sts', user, userId });

test('an exchange for the signed-in user matches by login or by Okta id', () => {
  assert.equal(isMine(exchange('alice@example.com', '00uAAA'), { sub: 'alice@example.com' }, null), true);
  assert.equal(isMine(exchange('alice@example.com', '00uAAA'), { sub: '00uAAA' }, null), true);
  assert.equal(isMine(exchange('alice@example.com', '00uAAA'), { sub: 'x', uid: '00uAAA' }, null), true);
  assert.equal(isMine(exchange('Alice@Example.com', '00uAAA'), {}, { email: 'alice@example.com' }), true, 'case-insensitive');
});

test('another user’s exchange never matches', () => {
  assert.equal(isMine(exchange('bob@example.com', '00uBBB'), { sub: 'alice@example.com', uid: '00uAAA' }, { email: 'alice@example.com' }), false);
});

test('fails closed when identity or attribution is missing', () => {
  assert.equal(isMine(exchange('alice@example.com', '00uAAA'), null, null), false, 'visitor has no claims');
  assert.equal(isMine(exchange(undefined, undefined), { sub: 'alice@example.com' }, null), false, 'entry names nobody');
  assert.equal(isMine({}, {}, {}), false);
  assert.equal(isMine(undefined, { sub: 'a' }, null), false);
});
