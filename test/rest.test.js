import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { errorPayload, requestFailure, USER_AGENT, postJson } from '../lib/rest.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('USER_AGENT 的版本号与 package.json 一致', () => {
  // 三处手写版本号曾经漂移过（package.json 到 alpha 了，User-Agent 还停在 0.1.0）。
  // 发版时最容易漏的就是这种「不在功能路径上」的常量，所以让测试盯着。
  assert.equal(USER_AGENT, `dsh-search-fetch-router/${pkg.version}`);
});

test('postJson 把非 2xx 包成带 status 的错误，并读出 Retry-After', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('slow down', { status: 429, headers: { 'retry-after': '42' } });
  try {
    await assert.rejects(
      () => postJson({ url: 'https://example.test/x', label: 'Demo /x', headers: {}, body: {} }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 42_000);
        assert.match(error.message, /^Demo \/x returned HTTP 429: slow down$/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('postJson 把非 JSON 响应包成可诊断的错误', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>oops</html>', { status: 200 });
  try {
    await assert.rejects(
      () => postJson({ url: 'https://example.test/x', label: 'Demo /x', headers: {}, body: {} }),
      (error) => {
        assert.equal(error.status, 200);
        assert.match(error.message, /Demo \/x returned a body that is not JSON/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('postJson 把网络层失败包成带 label 的错误并保留 cause', async () => {
  const original = globalThis.fetch;
  const boom = new Error('socket hang up');
  globalThis.fetch = async () => {
    throw boom;
  };
  try {
    await assert.rejects(
      () => postJson({ url: 'https://example.test/x', label: 'Demo /x', headers: {}, body: {} }),
      (error) => {
        assert.equal(error.cause, boom);
        assert.equal(error.status, undefined);
        assert.match(error.message, /Demo \/x request failed: socket hang up/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('postJson 调用方取消时原样抛中止错误，不包装成 HTTP 失败', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    throw new DOMException('The operation was aborted.', 'AbortError');
  };
  try {
    await assert.rejects(
      () =>
        postJson({
          url: 'https://example.test/x',
          label: 'Demo /x',
          headers: {},
          body: {},
          signal: controller.signal,
        }),
      (error) => {
        assert.equal(error.name, 'AbortError');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('errorPayload: a bare error body is recognised', () => {
  // 上游用 4xx/5xx 报错是常态，但都出现过 200 + 错误体（Firecrawl 的 {success:false} 尤甚）。
  // 不认出来的话，「上游出错」和「确实零结果」在调用方看来一模一样。
  assert.equal(errorPayload({ success: false, error: 'blocked' }, ['data']), 'blocked');
  assert.equal(errorPayload({ error: 'quota exceeded' }, ['results']), 'quota exceeded');
  assert.equal(errorPayload({ detail: 'bad query' }, ['results']), 'bad query');
  assert.equal(errorPayload({ error: { message: 'nested reason' } }, ['results']), 'nested reason');
  assert.equal(errorPayload({ errors: [{ message: 'first failure' }] }, ['results']), 'first failure');
});

test('errorPayload: success:false without a reason still names the shape', () => {
  assert.equal(errorPayload({ success: false }, ['data']), 'upstream reported success: false');
});

test('errorPayload: a legitimate empty result set is NOT an error', () => {
  // 这是最关键的一条：空结果必须仍是「零结果」，不能因为「看起来空」就降级。
  assert.equal(errorPayload({ results: [] }, ['results']), undefined);
  assert.equal(errorPayload({ data: { web: [] } }, ['data']), undefined);
  assert.equal(errorPayload({ results: [], answer: '' }, ['results']), undefined);
});

test('errorPayload: a payload carrying both results and an error is treated as results', () => {
  // 有结果字段就以结果为准：部分失败不该让整次搜索降级。
  assert.equal(errorPayload({ results: [{ url: 'https://a' }], error: 'partial' }, ['results']), undefined);
});

test('errorPayload: non-object payloads are not errors', () => {
  assert.equal(errorPayload(undefined, ['results']), undefined);
  assert.equal(errorPayload(null, ['results']), undefined);
  assert.equal(errorPayload([1, 2], ['results']), undefined);
  assert.equal(errorPayload('text', ['results']), undefined);
});

test('requestFailure: marked request-level so the key pool leaves the key alone', () => {
  const failure = requestFailure('Demo /x', 'blocked');
  assert.equal(failure.requestLevel, true);
  assert.match(failure.message, /Demo \/x reported an error: blocked/);
});

test('errorPayload: reads an upstream errors[] array (string or object entries)', () => {
  // 有些上游把原因放 errors 数组而不是单数字段。
  assert.equal(errorPayload({ errors: ['rate limited'] }, ['results']), 'rate limited');
  assert.equal(errorPayload({ errors: [{ message: 'blocked by anti-bot' }] }, ['results']), 'blocked by anti-bot');
  assert.equal(errorPayload({ errors: [{ detail: 'quota' }] }, ['results']), 'quota');
  // 空数组 / 无可用文本的条目：不算错误体，落到最后的 undefined。
  assert.equal(errorPayload({ errors: [] }, ['results']), undefined);
  assert.equal(errorPayload({ errors: [{}] }, ['results']), undefined);
  // 完全没有可识别字段：正常响应。
  assert.equal(errorPayload({ resultCount: 0 }, ['results']), undefined);
});
