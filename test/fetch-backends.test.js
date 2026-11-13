import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  crossOriginTarget,
  FETCH_BACKENDS,
  FETCH_BACKEND_IDS,
  fetchFollowingCrossOrigin,
  lookupFetchBackend,
} from '../lib/fetch-backends.js';
import { FETCH_BACKENDS as ROUTER_FETCH_BACKENDS } from '../lib/router.js';

test('fetch registry: keys match the router constants exactly', () => {
  // router 的 FETCH_BACKENDS 是给 planFetchChain 用的纯决策常量，注册表是执行侧的适配器。
  // 两边取值必须一一对应，否则 chain 里出现的 id 在注册表里找不到。
  assert.deepEqual(Object.keys(FETCH_BACKENDS).sort(), Object.values(ROUTER_FETCH_BACKENDS).sort());
});

test('fetch registry: every entry is well-formed', () => {
  for (const [key, backend] of Object.entries(FETCH_BACKENDS)) {
    assert.equal(backend.id, key, 'id must equal its registry key');
    assert.equal(typeof backend.label, 'string');
    assert.ok(
      backend.keyRefsField === null || typeof backend.keyRefsField === 'string',
      'keyRefsField is either null (keyless) or a config field name',
    );
    assert.equal(typeof backend.timeoutField, 'string');
    assert.equal(typeof backend.defaultTimeoutMs, 'number');
    assert.equal(typeof backend.run, 'function');
  }
});

test('fetch registry: tavily, exa and firecrawl are keyed, http is keyless', () => {
  assert.equal(FETCH_BACKENDS[FETCH_BACKEND_IDS.tavily].keyRefsField, 'tavilyApiKeyRefs');
  assert.equal(FETCH_BACKENDS[FETCH_BACKEND_IDS.exa].keyRefsField, 'exaApiKeyRefs');
  assert.equal(FETCH_BACKENDS[FETCH_BACKEND_IDS.firecrawl].keyRefsField, 'firecrawlApiKeyRefs');
  assert.equal(FETCH_BACKENDS[FETCH_BACKEND_IDS.http].keyRefsField, null);
});

test('fetch registry: lookup returns the entry or undefined for unknown ids', () => {
  assert.equal(lookupFetchBackend('tavily'), FETCH_BACKENDS.tavily);
  assert.equal(lookupFetchBackend('nope'), undefined);
});

/** 替换 globalThis.fetch，记录每次请求，返回给定响应。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** `run` 需要的 read()：从普通对象取配置值。 */
function readFrom(values) {
  return (key) => values[key];
}

test('fetch registry: the Exa adapter maps /contents text into a text result', async () => {
  const stub = stubFetch(() => Response.json({ results: [{ url: 'https://example.com/a', text: 'exa body' }] }));
  try {
    const backend = FETCH_BACKENDS[FETCH_BACKEND_IDS.exa];
    const outcome = await backend.run({
      apiKey: 'exa-key',
      request: { url: 'https://example.com/a' },
      signal: undefined,
      budgetMs: 5_000,
      read: readFrom({}),
      maxBodyChars: 100_000,
    });
    assert.equal(outcome.kind, 'result');
    assert.equal(outcome.result.body.content, 'exa body');
    assert.equal(outcome.result.statusCode, 200);
    assert.equal(outcome.result.url, 'https://example.com/a');
    assert.equal(outcome.result.truncated, false);
    // 认证头必须是 x-api-key（Exa 不接受 Bearer）。
    assert.equal(stub.calls[0].init.headers['x-api-key'], 'exa-key');
  } finally {
    stub.restore();
  }
});

test('fetch registry: the Exa adapter reports an empty body as unusable, not an error', async () => {
  const stub = stubFetch(() => Response.json({ results: [{ url: 'https://example.com/a', text: '   ' }] }));
  try {
    const backend = FETCH_BACKENDS[FETCH_BACKEND_IDS.exa];
    const outcome = await backend.run({
      apiKey: 'exa-key',
      request: { url: 'https://example.com/a' },
      signal: undefined,
      budgetMs: 5_000,
      read: readFrom({}),
      maxBodyChars: 100_000,
    });
    // unusable 才会让执行层换下一家且不惩罚 key；抛错会误伤这把 key。
    assert.equal(outcome.kind, 'unusable');
    assert.match(outcome.reason, /empty body/);
  } finally {
    stub.restore();
  }
});

test('fetch registry: the Exa adapter surfaces the upstream failure reason, not a bare empty body', async () => {
  // /contents 抓不到时可能整体 200，把该 URL 放进 statuses 并给 error.tag。
  // 若只看 results[0].text，就只会报「empty body」，把「抓不到」和「页面是空的」混为一谈。
  const stub = stubFetch(() => Response.json({
    results: [],
    statuses: [{ id: 'https://example.com/a', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }],
  }));
  try {
    const backend = FETCH_BACKENDS[FETCH_BACKEND_IDS.exa];
    const outcome = await backend.run({
      apiKey: 'exa-key',
      request: { url: 'https://example.com/a' },
      signal: undefined,
      budgetMs: 5_000,
      read: readFrom({}),
      maxBodyChars: 100_000,
    });
    assert.equal(outcome.kind, 'unusable');
    assert.match(outcome.reason, /CRAWL_NOT_FOUND/);
  } finally {
    stub.restore();
  }
});

test('fetch registry: the Exa adapter truncates to maxBodyChars', async () => {
  const stub = stubFetch(() => Response.json({ results: [{ url: 'https://example.com/a', text: 'x'.repeat(50) }] }));
  try {
    const backend = FETCH_BACKENDS[FETCH_BACKEND_IDS.exa];
    const outcome = await backend.run({
      apiKey: 'exa-key',
      request: { url: 'https://example.com/a' },
      signal: undefined,
      budgetMs: 5_000,
      read: readFrom({}),
      maxBodyChars: 10,
    });
    assert.equal(outcome.kind, 'result');
    assert.equal(outcome.result.body.content.length, 10);
    assert.equal(outcome.result.truncated, true);
  } finally {
    stub.restore();
  }
});

test('fetch registry: the Exa adapter lets an HTTP failure throw so the key is rotated', async () => {
  const stub = stubFetch(() => new Response('rate limited', { status: 429 }));
  try {
    const backend = FETCH_BACKENDS[FETCH_BACKEND_IDS.exa];
    await assert.rejects(
      () => backend.run({
        apiKey: 'exa-key',
        request: { url: 'https://example.com/a' },
        signal: undefined,
        budgetMs: 5_000,
        read: readFrom({}),
        maxBodyChars: 100_000,
      }),
      (error) => {
        assert.equal(error.status, 429);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

/** 构造宿主的跨域重定向错误（形状与 dsh-web-fetch-http 抛的一致）。 */
function redirectBlocked(target) {
  const error = new Error(
    `cross-origin redirect to ${target} is not followed automatically; retry against that URL directly`,
  );
  error.code = 'WEB_REDIRECT_BLOCKED';
  return error;
}

test('cross-origin redirect: target is read out of the host error', () => {
  assert.equal(crossOriginTarget(redirectBlocked('https://exa.ai')), 'https://exa.ai');
  assert.equal(crossOriginTarget(new Error('boom')), undefined);
  assert.equal(crossOriginTarget({ code: 'WEB_PROVIDER_ERROR', message: 'x' }), undefined);
});

test('cross-origin redirect: follows the hop once and returns the second result', async () => {
  // 实测场景：docs.exa.ai 跳到 exa.ai，宿主拒绝跨域跟随，整次抓取被判失败。
  const seen = [];
  const provider = {
    async fetch(request) {
      seen.push(request.url);
      if (request.url === 'https://docs.exa.ai/x') throw redirectBlocked('https://exa.ai');
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'ok' }, truncated: false };
    },
  };
  const result = await fetchFollowingCrossOrigin(provider, { url: 'https://docs.exa.ai/x' }, undefined);
  assert.deepEqual(seen, ['https://docs.exa.ai/x', 'https://exa.ai']);
  assert.equal(result.body.content, 'ok');
});

test('cross-origin redirect: gives up instead of looping on a cycle', async () => {
  let calls = 0;
  const provider = {
    async fetch(request) {
      calls += 1;
      throw redirectBlocked(request.url === 'https://a.test/' ? 'https://b.test/' : 'https://a.test/');
    },
  };
  await assert.rejects(
    () => fetchFollowingCrossOrigin(provider, { url: 'https://a.test/' }, undefined),
    (error) => {
      assert.equal(error.code, 'WEB_REDIRECT_BLOCKED');
      return true;
    },
  );
  assert.equal(calls, 2, 'one hop each way, then the cycle is refused');
});

test('cross-origin redirect: other failures are rethrown untouched', async () => {
  const boom = new Error('ECONNREFUSED');
  const provider = { async fetch() { throw boom; } };
  await assert.rejects(
    () => fetchFollowingCrossOrigin(provider, { url: 'https://a.test/' }, undefined),
    (error) => {
      assert.equal(error, boom);
      return true;
    },
  );
});
