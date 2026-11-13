import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebError } from '@deepseek-ai/dsh-web';

import { asWebError, CODES, isAbortError, webError } from '../lib/errors.js';

test('errors: webError carries the code the seam routes on', () => {
  const error = webError('boom', CODES.FETCH_ALL_FAILED);
  assert.equal(error.code, CODES.FETCH_ALL_FAILED);
  assert.equal(error.message, 'boom');
});

test('errors: webError keeps the cause when one is given', () => {
  const cause = new Error('root');
  assert.equal(webError('boom', CODES.ABORTED, cause).cause, cause);
  assert.equal(webError('boom', CODES.ABORTED).cause, undefined);
});

test('errors: asWebError returns an existing WebError untouched, no nesting', () => {
  const original = webError('already wrapped', CODES.SEARCH_ALL_FAILED);
  assert.equal(asWebError(original, CODES.ABORTED), original);
  // 原样返回意味着 code 不会被 fallbackCode 覆盖——已经带码的错误不该被重新贴标签。
  assert.equal(asWebError(original, CODES.ABORTED).code, CODES.SEARCH_ALL_FAILED);
});

test('errors: asWebError wraps a plain Error and keeps it as cause', () => {
  const cause = new TypeError('bad shape');
  const wrapped = asWebError(cause, CODES.FETCH_ALL_FAILED);
  assert.equal(wrapped.code, CODES.FETCH_ALL_FAILED);
  assert.equal(wrapped.message, 'bad shape');
  assert.equal(wrapped.cause, cause);
});

test('errors: asWebError stringifies a non-Error thrown value and drops the cause', () => {
  const wrapped = asWebError('just a string', CODES.FETCH_ALL_FAILED);
  assert.equal(wrapped.code, CODES.FETCH_ALL_FAILED);
  assert.equal(wrapped.message, 'just a string');
  assert.equal(wrapped.cause, undefined);
});

test('errors: isAbortError recognises our own code, AbortError and ABORT_ERR', () => {
  assert.equal(isAbortError(webError('cancelled', CODES.ABORTED)), true);
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  assert.equal(isAbortError(aborted), true);
  assert.equal(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' })), true);
  assert.equal(isAbortError(new Error('plain failure')), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError(null), false);
});

test('errors: every code is namespaced so it cannot collide with host codes', () => {
  for (const code of Object.values(CODES)) {
    assert.match(code, /^WEB_[A-Z_]+$/);
  }
  assert.equal(new WebError('x', CODES.INVALID_URL).code, CODES.INVALID_URL);
});
