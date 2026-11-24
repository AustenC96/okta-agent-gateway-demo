import test from 'node:test';
import assert from 'node:assert/strict';
import { findConsentUrl } from '../server.js';

test('finds the Okta consent link whether it is an MCP error or plain tool-result text', () => {
  const url = 'https://demo.oktapreview.com/oauth2/v1/sts/redirect?dataHandle=abc123_-XYZ';
  assert.equal(findConsentUrl({ result: { isError: true, content: [{ type: 'text', text: `Connection required: visit ${url} to connect` }] } }), url);
  assert.equal(findConsentUrl({ error: { code: -32000, message: 'needs consent', data: { url: 'https://x.example.com/consent?id=1' } } }), 'https://x.example.com/consent?id=1');
});

test('ordinary tool results and errors are not mistaken for consent', () => {
  assert.equal(findConsentUrl({ result: { content: [{ type: 'text', text: '{"login":"octocat","html_url":"https://github.com/octocat"}' }] } }), null);
  assert.equal(findConsentUrl({ error: { code: -32602, message: 'invalid params' } }), null);
  assert.equal(findConsentUrl(null), null);
});
