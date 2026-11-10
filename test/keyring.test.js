import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPermanentInvalid, KeyRing, statusOf } from '../lib/keyring.js';

const noCooldown = { cooldownMs: 60_000 };

function ring(refs, resolve, options = noCooldown) {
  return new KeyRing({ refs, resolve, ...options });
}

test('status: reads both status and statusCode', () => {
  assert.equal(statusOf({ status: 401 }), 401);
  assert.equal(statusOf({ statusCode: 403 }), 403);
  assert.equal(statusOf({ status: '401' }), undefined);
  assert.equal(statusOf(undefined), undefined);
});

test('permanent: a 401 with an explicit phrase is permanent', () => {
  assert.equal(isPermanentInvalid({ status: 401, message: 'Invalid API key provided' }), true);
});

test('permanent: a 403 with a revocation phrase is permanent', () => {
  assert.equal(isPermanentInvalid({ status: 403, message: 'this key was revoked' }), true);
});

test('permanent: a bare 401 is not enough on its own', () => {
  assert.equal(isPermanentInvalid({ status: 401, message: 'gateway rejected the request' }), false);
});

test('permanent: a 500 never counts as permanent', () => {
  assert.equal(isPermanentInvalid({ status: 500, message: 'invalid api key' }), false);
});

test('ring: candidates follow the configured order', async () => {
  const keyring = ring(['A', 'B', 'C'], async () => 'v');
  assert.deepEqual(keyring.candidates(0), ['A', 'B', 'C']);
});

test('ring: a successful call advances the cursor', async () => {
  const keyring = ring(['A', 'B', 'C'], async () => 'v');
  keyring.advance('A');
  assert.deepEqual(keyring.candidates(0), ['B', 'C', 'A']);
});

test('ring: the cursor wraps around', async () => {
  const keyring = ring(['A', 'B'], async () => 'v');
  keyring.advance('B');
  assert.deepEqual(keyring.candidates(0), ['A', 'B']);
});

test('ring: a penalized key is skipped while cooling', async () => {
  const keyring = ring(['A', 'B'], async () => 'v');
  keyring.penalize('A', { status: 500, message: 'boom' }, 1_000);
  assert.deepEqual(keyring.candidates(1_000), ['B']);
  assert.deepEqual(keyring.candidates(61_000), ['A', 'B']);
});

test('ring: a permanently invalid key is never offered again', async () => {
  const keyring = ring(['A', 'B'], async () => 'v');
  assert.equal(keyring.penalize('A', { status: 401, message: 'invalid api key' }, 0), 'dead');
  assert.deepEqual(keyring.candidates(0), ['B']);
  assert.deepEqual(keyring.candidates(1e9), ['B']);
});

test('ring: penalize reports which kind of penalty it applied', async () => {
  const keyring = ring(['A'], async () => 'v');
  assert.equal(keyring.penalize('A', { status: 429, message: 'slow down' }, 0), 'cooldown');
});

test('ring: unresolvable references are dropped, not penalized', async () => {
  const keyring = ring(['A', 'B'], async (ref) => {
    if (ref === 'A') throw new TypeError('bad reference name');
    return 'value';
  });
  const candidates = await keyring.resolvedCandidates(0);
  assert.deepEqual(candidates, [{ ref: 'B', value: 'value' }]);
  assert.deepEqual(keyring.candidates(0), ['A', 'B']);
});

test('ring: references resolving to an empty string count as unconfigured', async () => {
  const keyring = ring(['A'], async () => '');
  assert.deepEqual(await keyring.resolvedCandidates(0), []);
});

test('ring: hasAnyConfigured ignores cooldowns but respects permanent failures', async () => {
  const keyring = ring(['A'], async () => 'v');
  keyring.penalize('A', { status: 500, message: 'boom' }, 0);
  assert.equal(keyring.hasAnyConfigured(), true);
  keyring.penalize('A', { status: 401, message: 'revoked' }, 0);
  assert.equal(keyring.hasAnyConfigured(), false);
});

test('ring: an empty reference list is inert', async () => {
  const keyring = ring([], async () => 'v');
  assert.deepEqual(keyring.candidates(0), []);
  assert.equal(keyring.hasAnyConfigured(), false);
  assert.deepEqual(await keyring.resolvedCandidates(0), []);
});

test('ring: a zero or negative cooldown falls back to the default', async () => {
  const keyring = ring(['A'], async () => 'v', { cooldownMs: 0 });
  keyring.penalize('A', { status: 500, message: 'boom' }, 0);
  assert.deepEqual(keyring.candidates(30_000), []);
});
