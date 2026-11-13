import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { USER_AGENT, postJson } from '../lib/rest.js';

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
