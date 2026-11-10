import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertFetchableUrl } from '../lib/urls.js';

class FakeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const makeError = (message, code) => new FakeError(message, code);

test('url: a valid https URL parses', () => {
  const parsed = assertFetchableUrl('https://example.com/a', makeError);
  assert.equal(parsed.host, 'example.com');
});

test('url: empty and non-string are rejected', () => {
  assert.throws(() => assertFetchableUrl('', makeError), /non-empty url/);
  assert.throws(() => assertFetchableUrl(undefined, makeError), /non-empty url/);
});

test('url: over-long URLs are rejected', () => {
  assert.throws(() => assertFetchableUrl(`https://example.com/${'a'.repeat(3000)}`, makeError), /2048-character limit/);
});

test('url: non-http schemes are rejected', () => {
  assert.throws(() => assertFetchableUrl('file:///etc/passwd', makeError), /only supports http and https/);
});

test('url: embedded credentials are rejected', () => {
  assert.throws(() => assertFetchableUrl('https://user:fc-CANARY-NOT-A-REAL-KEY@example.com/', makeError), /embedded credentials/);
});

test('url: every rejection carries WEB_INVALID_URL', () => {
  try {
    assertFetchableUrl('ftp://example.com/', makeError);
    assert.fail('expected a throw');
  } catch (error) {
    assert.equal(error.code, 'WEB_INVALID_URL');
  }
});
