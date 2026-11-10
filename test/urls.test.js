import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertFetchableUrl, globToRegExp, matchesAnyPattern } from '../lib/urls.js';

class FakeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const makeError = (message, code) => new FakeError(message, code);

test('glob: * does not cross a slash', () => {
  assert.equal(globToRegExp('a/*/c').test('a/b/c'), true);
  assert.equal(globToRegExp('a/*/c').test('a/b/x/c'), false);
});

test('glob: ** crosses slashes', () => {
  assert.equal(globToRegExp('a/**').test('a/b/c/d'), true);
});

test('glob: regex metacharacters are literal', () => {
  assert.equal(globToRegExp('a.b').test('axb'), false);
  assert.equal(globToRegExp('a.b').test('a.b'), true);
});

test('patterns: empty list never matches', () => {
  assert.equal(matchesAnyPattern('https://example.com/a', []), false);
});

test('patterns: host + path is the match surface', () => {
  assert.equal(matchesAnyPattern('https://docs.example.com/guide', ['docs.example.com/**']), true);
  assert.equal(matchesAnyPattern('https://other.example.com/guide', ['docs.example.com/**']), false);
});

test('patterns: a bare host also matches its subpaths', () => {
  assert.equal(matchesAnyPattern('https://example.com/deep/path', ['example.com']), true);
  assert.equal(matchesAnyPattern('https://example.com', ['example.com']), true);
});

test('patterns: the query string is not part of the match surface', () => {
  assert.equal(matchesAnyPattern('https://example.com/a?q=1', ['example.com/a']), true);
});

test('patterns: an invalid URL matches nothing', () => {
  assert.equal(matchesAnyPattern('not a url', ['**']), false);
});

test('patterns: blank entries are ignored', () => {
  assert.equal(matchesAnyPattern('https://example.com/a', ['', '   ']), false);
});

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
