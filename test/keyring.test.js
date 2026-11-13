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

test('ring: a 429 cools the key down five times longer than a normal failure', async () => {
  const rateLimited = ring(['A'], async () => 'v', { cooldownMs: 1_000 });
  rateLimited.penalize('A', { status: 429, message: 'slow down' }, 0);
  assert.equal(rateLimited.cooldowns.get('A'), 5_000);

  const plain = ring(['A'], async () => 'v', { cooldownMs: 1_000 });
  plain.penalize('A', { status: 500, message: 'boom' }, 0);
  assert.equal(plain.cooldowns.get('A'), 1_000);
});

test('ring: rate-limit wording without a 429 also cools longer', async () => {
  const keyring = ring(['A'], async () => 'v', { cooldownMs: 1_000 });
  keyring.penalize('A', { message: 'Too Many Requests' }, 0);
  assert.equal(keyring.cooldowns.get('A'), 5_000);
});

test('ring: an exhausted quota cools the key far longer than a rate limit', async () => {
  const quota = ring(['A'], async () => 'v', { cooldownMs: 1_000 });
  assert.equal(quota.penalize('A', { status: 432, message: 'plan limit exceeded' }, 0), 'quota');
  assert.equal(quota.cooldowns.get('A'), 60_000);
  // 额度耗尽不是 key 失效：这把 key 之后还可能恢复，所以不能进 dead。
  assert.equal(quota.dead.has('A'), false);

  const paygo = ring(['A'], async () => 'v', { cooldownMs: 1_000 });
  paygo.penalize('A', { status: 433, message: 'paygo limit' }, 0);
  assert.equal(paygo.cooldowns.get('A'), 60_000);
});

test('ring: Retry-After overrides the built-in cooldown', async () => {
  const keyring = ring(['A'], async () => 'v', { cooldownMs: 1_000 });
  keyring.penalize('A', { status: 429, message: 'slow down', retryAfterMs: 45_000 }, 0);
  assert.equal(keyring.cooldowns.get('A'), 45_000);
});

test('ring: an absurd Retry-After is capped at a day', async () => {
  const keyring = ring(['A'], async () => 'v', { cooldownMs: 1_000 });
  keyring.penalize('A', { status: 429, message: 'slow down', retryAfterMs: 30 * 24 * 60 * 60 * 1000 }, 0);
  assert.equal(keyring.cooldowns.get('A'), 24 * 60 * 60 * 1000);
});

test('ring: a timeout cools the key briefly, not for the whole cycle', async () => {
  // 超时是「这次慢」，不是「这把 key 坏了」。按默认冷却整把 key，单 key 用户会因一次
  // 慢请求让唯一一把 key 停摆一整个冷却周期。
  const slow = ring(['A'], async () => 'v', { cooldownMs: 60_000 });
  slow.penalize('A', { message: 'request timed out' }, 0);
  assert.equal(slow.cooldowns.get('A'), 12_000);
  assert.deepEqual(slow.candidates(11_000), []);
  assert.deepEqual(slow.candidates(12_000), ['A']);
});

test('ring: a TimeoutError from AbortSignal.timeout also cools briefly', async () => {
  const keyring = ring(['A'], async () => 'v', { cooldownMs: 60_000 });
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  keyring.penalize('A', error, 0);
  assert.equal(keyring.cooldowns.get('A'), 12_000);
});

test('ring: a timeout never cools longer than its own short window, even with Retry-After', async () => {
  const keyring = ring(['A'], async () => 'v', { cooldownMs: 60_000 });
  keyring.penalize('A', { message: 'timed out', retryAfterMs: 3_600_000 }, 0);
  assert.equal(keyring.cooldowns.get('A'), 12_000);
});

test('ring: a 504 counts as a timeout, a 500 does not', async () => {
  const gateway = ring(['A'], async () => 'v', { cooldownMs: 60_000 });
  gateway.penalize('A', { status: 504, message: 'gateway timeout' }, 0);
  assert.equal(gateway.cooldowns.get('A'), 12_000);

  const server = ring(['A'], async () => 'v', { cooldownMs: 60_000 });
  server.penalize('A', { status: 500, message: 'boom' }, 0);
  assert.equal(server.cooldowns.get('A'), 60_000);
});

test('ring: concurrent requests claim different starting points', async () => {
  // 共用游标会让并发请求都从第一把 key 开始，多 key 池在并发下退化成单 key。
  const keyring = ring(['A', 'B', 'C'], async () => 'v');
  const starts = [keyring.claim(), keyring.claim(), keyring.claim()];
  assert.deepEqual(starts, [0, 1, 2]);
  assert.equal(keyring.claim(), 0);
  assert.deepEqual(keyring.candidates(0, starts[1]), ['B', 'C', 'A']);
});

test('ring: claim on an empty ring is inert', async () => {
  const keyring = ring([], async () => 'v');
  assert.equal(keyring.claim(), 0);
  assert.deepEqual(keyring.candidates(0, 0), []);
});
