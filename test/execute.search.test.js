import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { DEEPSEEK_DEFAULT_BASE_URL } from '@deepseek-ai/dsh-web-search-deepseek';

import { Config } from '../lib/config.js';
import { createRouter } from '../lib/execute.js';
import { SEARCH_BACKENDS } from '../lib/search-backends.js';

import {
  fakeCtx,
  fakeSettings,
  fakeCredentials,
  stubFetch,
  configWith,
} from './helpers/execute-harness.js';

test('search: a blank or missing query is rejected before any credit is spent', async () => {
  const stub = stubFetch(() => {
    throw new Error('should not be reached');
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    for (const bad of [{ query: '' }, { query: '   ' }, {}, undefined]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => router.search(bad, undefined),
        (error) => {
          assert.equal(error.code, 'WEB_INVALID_QUERY');
          return true;
        },
      );
    }
    assert.equal(stub.calls.length, 0, 'a blank query must never reach the network');
  } finally {
    stub.restore();
  }
});

test('search: an already-aborted signal never reaches the network', async () => {
  const stub = stubFetch(() => {
    throw new Error('should not be reached');
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => router.search({ query: 'hello' }, controller.signal),
      (error) => {
        assert.equal(error.code, 'WEB_ABORTED');
        return true;
      },
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('search: Tavily results come back unchanged', async () => {
  const stub = stubFetch(() => Response.json({
    results: [{ url: 'https://a.example.com', title: 'A', content: 'snip' }],
    answer: 'answer',
  }));
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    const result = await router.search({ query: 'q', maxResults: 5 }, undefined);
    assert.equal(result.content, 'answer');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, 'https://a.example.com');
  } finally {
    stub.restore();
  }
});

test('search: a failing Tavily key rolls over to the next one', async () => {
  const seen = [];
  const stub = stubFetch((url, init) => {
    seen.push(init.headers.authorization);
    if (init.headers.authorization === 'Bearer bad') return new Response('nope', { status: 500 });
    return Response.json({ results: [{ url: 'https://a.example.com' }] });
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY_1: 'bad', TAVILY_API_KEY_2: 'good' }) });
    const router = createRouter(ctx, configWith({ tavilyApiKeyRefs: ['TAVILY_API_KEY_1', 'TAVILY_API_KEY_2'] }));
    const result = await router.search({ query: 'q' }, undefined);
    assert.equal(result.sources.length, 1);
    assert.deepEqual(seen, ['Bearer bad', 'Bearer good']);
  } finally {
    stub.restore();
  }
});

test('search: no usable provider at all is reported as such', async () => {
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, configWith({}));
  await assert.rejects(
    () => router.search({ query: 'q' }, undefined),
    (error) => {
      assert.equal(error.code, 'WEB_SEARCH_ALL_PROVIDERS_FAILED');
      assert.match(error.message, /no web search provider is usable/);
      return true;
    },
  );
});

test('search: every Tavily key failing with fallback off surfaces the summary', async () => {
  const stub = stubFetch(() => new Response('down', { status: 500 }));
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    await assert.rejects(
      () => router.search({ query: 'q' }, undefined),
      (error) => {
        assert.equal(error.code, 'WEB_SEARCH_ALL_PROVIDERS_FAILED');
        assert.match(error.message, /tavily: /);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('search: the pool rotates across calls, so two calls do not hit the same key', async () => {
  const seen = [];
  const stub = stubFetch((url, init) => {
    seen.push(init.headers.authorization);
    return Response.json({ results: [{ url: 'https://a.example.com' }] });
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY_1: 'one', TAVILY_API_KEY_2: 'two' }) });
    const router = createRouter(ctx, configWith({ tavilyApiKeyRefs: ['TAVILY_API_KEY_1', 'TAVILY_API_KEY_2'] }));
    await router.search({ query: 'q1' }, undefined);
    await router.search({ query: 'q2' }, undefined);
    assert.deepEqual(seen, ['Bearer one', 'Bearer two']);
  } finally {
    stub.restore();
  }
});

test('search: a key that just failed stays out of the next call (cooldown survives)', async () => {
  const seen = [];
  const stub = stubFetch((url, init) => {
    seen.push(init.headers.authorization);
    if (init.headers.authorization === 'Bearer bad') return new Response('nope', { status: 500 });
    return Response.json({ results: [{ url: 'https://a.example.com' }] });
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY_1: 'bad', TAVILY_API_KEY_2: 'good' }) });
    const router = createRouter(ctx, configWith({ tavilyApiKeyRefs: ['TAVILY_API_KEY_1', 'TAVILY_API_KEY_2'] }));
    await router.search({ query: 'q1' }, undefined);
    assert.deepEqual(seen, ['Bearer bad', 'Bearer good']);
    seen.length = 0;
    await router.search({ query: 'q2' }, undefined);
    // bad 还在冷却里，这一轮不该再被撞一次
    assert.deepEqual(seen, ['Bearer good']);
  } finally {
    stub.restore();
  }
});

test('search: official fallback reads baseURL from the web-search-deepseek settings section', async () => {
  const seen = [];
  const stub = stubFetch((url) => {
    seen.push(String(url));
    return Response.json({
      content: [{
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://a.example.com', title: 'A' }],
      }],
    });
  });
  try {
    // 没有 Tavily key ⇒ 链里只剩 official；searchFallback 打开它。
    const ctx = fakeCtx({
      credentials: fakeCredentials({ DEEPSEEK_API_KEY: 'sk-test' }),
      settings: fakeSettings({ baseURL: 'https://magpie.example/anthropic/v1' }),
    });
    const router = createRouter(ctx, Config({ fetchFallback: false, searchFallback: true }));
    const result = await router.search({ query: 'q' }, undefined);
    // 请求必须打到用户配的 magpie 网关，而不是官方默认端点。
    assert.deepEqual(seen, ['https://magpie.example/anthropic/v1/messages']);
    assert.equal(result.sources[0].url, 'https://a.example.com');
  } finally {
    stub.restore();
  }
});

test('search: official fallback without a settings section uses the DeepSeek default baseURL', async () => {
  const seen = [];
  const stub = stubFetch((url) => {
    seen.push(String(url));
    return Response.json({
      content: [{
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://a.example.com' }],
      }],
    });
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ DEEPSEEK_API_KEY: 'sk-test' }) });
    const router = createRouter(ctx, Config({ fetchFallback: false, searchFallback: true }));
    await router.search({ query: 'q' }, undefined);
    assert.deepEqual(seen, [`${DEEPSEEK_DEFAULT_BASE_URL}/messages`]);
  } finally {
    stub.restore();
  }
});

test('search: every Tavily key failing falls back to the official provider when fallback is on', async () => {
  const seen = [];
  const stub = stubFetch((url) => {
    seen.push(String(url));
    if (url.includes('tavily.com')) return new Response('down', { status: 500 });
    if (url.endsWith('/messages')) {
      return Response.json({
        content: [{
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://official.example.com', title: 'O' }],
        }],
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({
      credentials: fakeCredentials({ TAVILY_API_KEY: 'bad', DEEPSEEK_API_KEY: 'sk-test' }),
    });
    const router = createRouter(ctx, Config({ fetchFallback: false, searchFallback: true }));
    const result = await router.search({ query: 'q' }, undefined);
    assert.equal(result.sources[0].url, 'https://official.example.com');
    // 先打 Tavily（失败），再打官方；共两次调用。
    assert.equal(seen.length, 2);
    assert.match(seen[0], /tavily/);
    assert.match(seen[1], /\/messages$/);
  } finally {
    stub.restore();
  }
});

test('search: a newly registered backend is picked up via providerOrder with no code branch', async () => {
  const calls = [];
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run({ apiKey, request }) {
      calls.push({ apiKey, query: request.query });
      return { sources: [{ url: 'https://fake.example/x' }], truncated: false };
    },
  };
  // 用普通对象配置，绕过 schema 里没有的 fakeApiKeyRefs——read() 直接读裸值即可。
  const config = {
    providerOrder: ['fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/x');
  assert.deepEqual(calls, [{ apiKey: 'fk', query: 'q' }]);
});

test('search: an unknown id in providerOrder is skipped, not fatal', async () => {
  const calls = [];
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run({ apiKey, request }) {
      calls.push({ apiKey, query: request.query });
      return { sources: [{ url: 'https://fake.example/ok' }], truncated: false };
    },
  };
  const config = {
    providerOrder: ['ghost', 'fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/ok');
  assert.deepEqual(calls, [{ apiKey: 'fk', query: 'q' }], 'ghost is skipped, only fake runs');
});

test('search: debug log records which backend served the request', async () => {
  const debugLines = [];
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run() {
      return { sources: [{ url: 'https://fake.example/ok' }], truncated: false };
    },
  };
  const config = {
    providerOrder: ['fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
  };
  const ctx = fakeCtx({
    credentials: fakeCredentials({ FAKE_KEY: 'fk' }),
    logger: { warn() {}, debug: (message) => debugLines.push(message) },
  });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  await router.search({ query: 'q' }, undefined);
  assert.ok(debugLines.some((line) => line.includes('served by fake')), debugLines.join('\n'));
  // 命中日志带耗时，便于排查每个后端到底慢在哪。
  assert.match(debugLines.join('\n'), /served by fake \(key FAKE_KEY\) in \d+ms/);
});

test('search: exa is used when listed in providerOrder', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('api.exa.ai')) {
      return Response.json({ results: [{ title: 'E', url: 'https://e.example', text: 'snippet' }] });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ EXA_API_KEY: 'ek' }) });
    const router = createRouter(ctx, configWith({ providerOrder: ['exa'] }));
    const result = await router.search({ query: 'hello' }, undefined);
    assert.equal(result.sources[0].url, 'https://e.example');
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /api\.exa\.ai\/search$/);
    assert.equal(stub.calls[0].init.headers['x-api-key'], 'ek');
    assert.equal(JSON.parse(stub.calls[0].init.body).query, 'hello');
  } finally {
    stub.restore();
  }
});

test('search: key rotation cannot spend more than the total budget', async () => {
  // 段预算（tavilyTimeoutMs）是「每把 key 的上限」，不是整个后端共享的一份。
  // 若循环里照抄外层的 budget，N 把 key 会各吃满一次段预算，总耗时变成 N×段预算，
  // 总预算被彻底穿透：用户设了 2.6s，实际等了 2.1s 还在打第三把。
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stub = stubFetch(async () => {
    await sleep(700);
    throw new TypeError('fetch failed');
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ K1: 'a', K2: 'b', K3: 'c' }) });
    const router = createRouter(ctx, configWith({
      providerOrder: ['tavily'],
      tavilyApiKeyRefs: ['K1', 'K2', 'K3'],
      searchTotalBudgetMs: 2_600,
      tavilyTimeoutMs: 2_000,
    }));
    await assert.rejects(() => router.search({ query: 'q' }), () => true);
    // 第一把 700ms 后剩余 1.9s < MIN_SEGMENT_BUDGET_MS(2s)，必须就此收手。
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('search: an exhausted total budget yields WEB_SEARCH_BUDGET_EXHAUSTED', async () => {
  const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
  const router = createRouter(ctx, configWith({ searchTotalBudgetMs: 1 }));
  await assert.rejects(
    router.search({ query: 'q' }, undefined),
    (error) => error.code === 'WEB_SEARCH_BUDGET_EXHAUSTED',
  );
});

test('search: verboseLog routes the served-by note to info instead of debug', async () => {
  const infoLines = [];
  const debugLines = [];
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run() { return { sources: [{ url: 'https://fake.example/v' }], truncated: false }; },
  };
  const config = {
    providerOrder: ['fake'], fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000,
    searchFallback: false, verboseLog: true,
  };
  const ctx = fakeCtx({
    credentials: fakeCredentials({ FAKE_KEY: 'fk' }),
    logger: { warn() {}, info: (m) => infoLines.push(m), debug: (m) => debugLines.push(m) },
  });
  const router = createRouter(ctx, config, { searchBackends: { fake: fakeBackend } });
  await router.search({ query: 'q' }, undefined);
  assert.ok(infoLines.some((line) => line.includes('served by fake')), infoLines.join('\n'));
  assert.equal(debugLines.length, 0);
});

test('search: concurrent requests spread across the key pool', async () => {
  // 共用游标会让并发请求都从第一把 key 开始，多 key 池在并发下退化成单 key。
  const used = [];
  const stub = stubFetch(async (url, init) => {
    used.push(init.headers.authorization.replace('Bearer ', ''));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ results: [{ url: 'https://a.example.com' }] });
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ K1: 'K1', K2: 'K2', K3: 'K3' }) });
    const router = createRouter(
      ctx,
      configWith({ tavilyApiKeyRefs: ['K1', 'K2', 'K3'], searchFallback: false }),
    );
    await Promise.all([1, 2, 3].map(() => router.search({ query: 'q' }, undefined)));
    assert.equal(new Set(used).size, 3, `三个并发请求应各用一把 key，实际：${used.join(', ')}`);
  } finally {
    stub.restore();
  }
});

test('search: a 200 error body degrades to the next backend instead of returning zero results', async () => {
  // 上游 200 但响应体是错误时，若当成「零结果」，用户拿到空结果、链也不降级，故障被静默吞掉。
  const stub = stubFetch((url) => {
    if (url.includes('api.tavily.com')) return Response.json({ error: 'quota exceeded for this key' });
    if (url.includes('api.exa.ai')) return Response.json({ results: [{ url: 'https://exa.example' }] });
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 't', EXA_API_KEY: 'e' }) });
    const router = createRouter(ctx, configWith({ providerOrder: ['tavily', 'exa'] }));
    const result = await router.search({ query: 'q' }, undefined);
    assert.equal(result.sources[0].url, 'https://exa.example');
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('search: a 200 error body does not cool down the key, because the key is not at fault', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('api.tavily.com')) return Response.json({ error: 'upstream hiccup' });
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ T1: 'a', T2: 'b' }) });
    const router = createRouter(
      ctx,
      configWith({ tavilyApiKeyRefs: ['T1', 'T2'], searchFallback: false }),
    );
    await assert.rejects(() => router.search({ query: 'q' }, undefined), /upstream hiccup/);
    const afterFirst = stub.calls.length;
    await assert.rejects(() => router.search({ query: 'q' }, undefined), /upstream hiccup/);
    assert.ok(stub.calls.length > afterFirst, '两把 key 都不该被冷却：第二轮仍要能触网');
  } finally {
    stub.restore();
  }
});

// --- 覆盖补齐：keyless 分支的错误处理、credentials 抛错、note 吞日志异常 ---

test('search: a keyless backend that throws is recorded as a failure and reported', async () => {
  const keyless = {
    id: 'fkless', label: 'FK', keyRefsField: null, timeoutField: null, defaultTimeoutMs: 5_000,
    isAvailable: () => true,
    async run() { throw new Error('kaboom'); },
  };
  const config = { providerOrder: ['fkless'], searchFallback: false, searchTotalBudgetMs: 30_000, cooldownMs: 60_000 };
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, config, { searchBackends: { fkless: keyless } });
  await assert.rejects(() => router.search({ query: 'q' }, undefined), /kaboom/);
});

test('search: an aborted keyless backend surfaces as WEB_ABORTED, not a backend failure', async () => {
  const keyless = {
    id: 'fkless', label: 'FK', keyRefsField: null, timeoutField: null, defaultTimeoutMs: 5_000,
    isAvailable: () => true,
    async run() { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  };
  const config = { providerOrder: ['fkless'], searchFallback: false, searchTotalBudgetMs: 30_000, cooldownMs: 60_000 };
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, config, { searchBackends: { fkless: keyless } });
  await assert.rejects(
    () => router.search({ query: 'q' }, undefined),
    (error) => error.code === 'WEB_ABORTED',
  );
});

test('search: a credentials service that throws is treated as "not configured", not a crash', async () => {
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run() { throw new Error('must not run without a key'); },
  };
  const config = { providerOrder: ['fake'], fakeApiKeyRefs: ['X'], fakeTimeoutMs: 5_000, cooldownMs: 60_000, searchFallback: false };
  const ctx = fakeCtx({ credentials: { async resolve() { throw new Error('credentials down'); } } });
  const router = createRouter(ctx, config, { searchBackends: { fake: fakeBackend } });
  await assert.rejects(() => router.search({ query: 'q' }, undefined), /no web search provider is usable/);
});

test('search: an unregistered provider id in providerOrder is skipped with a warn', async () => {
  const warns = [];
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run() {
      return { sources: [{ url: 'https://fake.example/ok' }], truncated: false };
    },
  };
  const config = {
    providerOrder: ['tavlp', 'fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
  };
  const ctx = fakeCtx({
    credentials: fakeCredentials({ FAKE_KEY: 'fk' }),
    logger: { warn: (message) => warns.push(message), debug() {} },
  });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/ok');
  assert.ok(
    warns.some((line) => line.includes('tavlp') && line.includes('未注册')),
    `expected a warning about the unknown id, got: ${warns.join(' | ')}`,
  );
});

test('search: maxResults is capped by maxSearchResults and respects a smaller request value', async () => {
  const seen = [];
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run({ request }) {
      seen.push(request.maxResults);
      return { sources: [{ url: 'https://fake.example/ok' }], truncated: false };
    },
  };
  const config = {
    providerOrder: ['fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
    maxSearchResults: 10,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  await router.search({ query: 'q', maxResults: 50 }, undefined);
  await router.search({ query: 'q', maxResults: 3 }, undefined);
  await router.search({ query: 'q' }, undefined);
  assert.deepEqual(seen, [10, 3, 10]);
});

test('search: maxSearchResults defaults to 20 when the config field is absent', async () => {
  const seen = [];
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run({ request }) {
      seen.push(request.maxResults);
      return { sources: [{ url: 'https://fake.example/ok' }], truncated: false };
    },
  };
  const config = {
    providerOrder: ['fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
    // maxSearchResults 故意不写：走 readNumber 的兜底默认值
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  await router.search({ query: 'q', maxResults: 50 }, undefined);
  await router.search({ query: 'q' }, undefined);
  assert.deepEqual(seen, [20, 20]);
});

test('search: enabled=false bypasses every configured key and needs the official fallback', async () => {
  const stub = stubFetch(() => {
    throw new Error('disabled router must not touch the network');
  });
  try {
    // 有 Tavily key，但总开关关掉：第三方一家都不许调，兜底也关 → 直接报「没有可用供应商」。
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({ enabled: false, searchFallback: false }));
    await assert.rejects(
      () => router.search({ query: 'q' }, undefined),
      /no web search provider is usable/,
    );
    assert.equal(stub.calls.length, 0, 'disabled router must not call any provider');
  } finally {
    stub.restore();
  }
});

test('search: maxResultsMode=provider-max overrides the unified cap with each backend hard limit', async () => {
  const seen = [];
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000, maxResults: 100,
    async run({ request }) { seen.push(request.maxResults); return { sources: [{ url: 'https://x/1' }], truncated: false }; },
  };
  const config = {
    providerOrder: ['fake'], fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000,
    searchFallback: false, maxSearchResults: 10, maxResultsMode: 'provider-max',
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  await router.search({ query: 'q', maxResults: 3 }, undefined);
  await router.search({ query: 'q' }, undefined);
  assert.deepEqual(seen, [100, 100]);
});

test('search: maxResultsMode=provider-default omits the count entirely', async () => {
  const seen = [];
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000, maxResults: 100,
    async run({ request }) { seen.push(request.maxResults); return { sources: [{ url: 'https://x/1' }], truncated: false }; },
  };
  const config = {
    providerOrder: ['fake'], fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000,
    searchFallback: false, maxResultsMode: 'provider-default',
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  await router.search({ query: 'q', maxResults: 3 }, undefined);
  assert.equal(seen[0], undefined);
});

test('search: an unknown maxResultsMode falls back to the unified cap', async () => {
  const seen = [];
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run({ request }) { seen.push(request.maxResults); return { sources: [{ url: 'https://x/1' }], truncated: false }; },
  };
  const config = {
    providerOrder: ['fake'], fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000,
    searchFallback: false, maxSearchResults: 10, maxResultsMode: 'bogus',
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  await router.search({ query: 'q', maxResults: 50 }, undefined);
  assert.equal(seen[0], 10);
});
