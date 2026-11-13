import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { DEEPSEEK_DEFAULT_BASE_URL } from '@deepseek-ai/dsh-web-search-deepseek';

import { Config } from '../lib/config.js';
import { createRouter } from '../lib/execute.js';
import { SEARCH_BACKENDS } from '../lib/search-backends.js';

/**
 * 造一个最小 ctx。只提供插件真正读的四样：`credentials`、`settings`、
 * `launchEnvironment`（未提供时 `launchEnvironmentOf` 会安全跳过）、`logger`。
 * @param options - `{credentials, settings}`。
 * @returns 假 ctx。
 */
function fakeCtx({ credentials, settings, logger } = {}) {
  return {
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'settings') return settings;
      return undefined;
    },
    logger: logger ?? { warn() {} },
  };
}

/**
 * 造一个只实现 `describe()` 的假 settings 服务，回放 `web-search-deepseek` 段。
 * 传 `undefined` 时返回空条目列表，等价于「用户没配这一段」。
 * @param value - 该段的值。
 * @returns 假 settings 服务。
 */
function fakeSettings(value) {
  return {
    describe() {
      return value === undefined ? [] : [{ ns: 'web-search-deepseek', value }];
    },
  };
}

/**
 * 造一个假的 credentials 服务，从字面量 map 解析。
 * @param values - 引用名 → 值。
 * @returns 假服务。
 */
function fakeCredentials(values) {
  return {
    async resolve(ref) {
      const value = values[ref];
      return value === undefined ? undefined : { value, source: 'file' };
    },
  };
}

/** 替换全局 fetch，记录调用并回放。 */
function stubFetch(responder) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function configWith(overrides) {
  return Config({ fetchFallback: false, searchFallback: false, ...overrides });
}

test('fetch: Tavily success short-circuits the chain', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/extract')) {
      return Response.json({ results: [{ raw_content: '# body '.repeat(50) }], failed_results: [] });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    const result = await router.fetch({ url: 'https://example.com/a' }, undefined);
    assert.equal(result.statusCode, 200);
    assert.match(result.body.content, /# body/);
    assert.equal(result.truncated, false);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('fetch: unusable Tavily content escalates to Firecrawl', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('tavily.com/extract')) {
      // 官方文档明说：全部失败时 HTTP 仍是 200，results 为空
      return Response.json({ results: [], failed_results: [{ url: 'https://example.com/a', error: 'blocked' }] });
    }
    if (url.includes('firecrawl.dev')) {
      return Response.json({ data: { markdown: '# from firecrawl', metadata: { statusCode: 200 } } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({
      credentials: fakeCredentials({ TAVILY_API_KEY: 'k', FIRECRAWL_API_KEY: 'f' }),
    });
    const router = createRouter(ctx, configWith({}));
    const result = await router.fetch({ url: 'https://example.com/a' }, undefined);
    assert.equal(result.body.content, '# from firecrawl');
    assert.equal(stub.calls.length, 2);
    assert.match(stub.calls[1].url, /firecrawl/);
  } finally {
    stub.restore();
  }
});

test('fetch: a failing Tavily key does not stop the next key in the pool', async () => {
  let extractCalls = 0;
  const stub = stubFetch((url, init) => {
    if (url.includes('tavily.com/extract')) {
      extractCalls += 1;
      const auth = init.headers.authorization;
      if (auth === 'Bearer bad') return new Response('nope', { status: 500 });
      return Response.json({ results: [{ raw_content: '# good key worked' }], failed_results: [] });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY_1: 'bad', TAVILY_API_KEY_2: 'good' }) });
    const router = createRouter(ctx, configWith({ tavilyApiKeyRefs: ['TAVILY_API_KEY_1', 'TAVILY_API_KEY_2'] }));
    const result = await router.fetch({ url: 'https://example.com/a' }, undefined);
    assert.match(result.body.content, /good key worked/);
    assert.equal(extractCalls, 2);
  } finally {
    stub.restore();
  }
});

test('fetch: with every backend down the error names them all', async () => {
  const stub = stubFetch(() => new Response('down', { status: 503 }));
  try {
    const ctx = fakeCtx({
      credentials: fakeCredentials({ TAVILY_API_KEY: 'k', FIRECRAWL_API_KEY: 'f' }),
    });
    const router = createRouter(ctx, configWith({}));
    await assert.rejects(
      () => router.fetch({ url: 'https://example.com/a' }, undefined),
      (error) => {
        assert.equal(error.code, 'WEB_FETCH_ALL_PROVIDERS_FAILED');
        assert.match(error.message, /tavily/);
        assert.match(error.message, /firecrawl/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('fetch: no configured key and fallback off is a clear failure, not a silent empty body', async () => {
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, configWith({}));
  await assert.rejects(
    () => router.fetch({ url: 'https://example.com/a' }, undefined),
    (error) => {
      assert.equal(error.code, 'WEB_FETCH_ALL_PROVIDERS_FAILED');
      assert.match(error.message, /no configured key reference resolved for any provider/);
      return true;
    },
  );
});

test('fetch: an invalid URL is rejected before any network call', async () => {
  const stub = stubFetch(() => {
    throw new Error('should not be reached');
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    await assert.rejects(
      () => router.fetch({ url: 'file:///etc/passwd' }, undefined),
      (error) => {
        assert.equal(error.code, 'WEB_INVALID_URL');
        return true;
      },
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('fetch: a missing request object is rejected as an invalid URL, not a TypeError', async () => {
  const stub = stubFetch(() => {
    throw new Error('should not be reached');
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    await assert.rejects(
      () => router.fetch(undefined, undefined),
      (error) => {
        assert.equal(error.code, 'WEB_INVALID_URL');
        return true;
      },
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

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

test('fetch: an already-aborted signal never reaches the network', async () => {
  const stub = stubFetch(() => {
    throw new Error('should not be reached');
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => router.fetch({ url: 'https://example.com/a' }, controller.signal),
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

test('fetch: a budget too small to start a segment reports exhaustion', async () => {
  const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
  const router = createRouter(ctx, configWith({ totalBudgetMs: 1, tavilyTimeoutMs: 15_000 }));
  await assert.rejects(
    () => router.fetch({ url: 'https://example.com/a' }, undefined),
    (error) => {
      assert.equal(error.code, 'WEB_FETCH_BUDGET_EXHAUSTED');
      return true;
    },
  );
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

test('fetch: maxBodyChars truncates a long Tavily body and marks it truncated', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/extract')) {
      return Response.json({ results: [{ raw_content: 'x'.repeat(500) }], failed_results: [] });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({ maxBodyChars: 40 }));
    const result = await router.fetch({ url: 'https://example.com/a' }, undefined);
    assert.equal(result.statusCode, 200);
    assert.equal(result.truncated, true);
    assert.equal(result.body.content.length, 40);
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

test('fetch: a Tavily error (not just unusable content) escalates to Firecrawl', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('tavily.com/extract')) return new Response('boom', { status: 500 });
    if (url.includes('firecrawl.dev')) {
      return Response.json({ data: { markdown: '# from firecrawl error path', metadata: { statusCode: 200 } } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({
      credentials: fakeCredentials({ TAVILY_API_KEY: 'bad', FIRECRAWL_API_KEY: 'f' }),
    });
    const router = createRouter(ctx, configWith({}));
    const result = await router.fetch({ url: 'https://example.com/a' }, undefined);
    assert.equal(result.body.content, '# from firecrawl error path');
    assert.equal(stub.calls.length, 2);
    assert.match(stub.calls[1].url, /firecrawl/);
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

test('fetch: key rotation cannot spend more than the total budget', async () => {
  // 与搜索同一条约束：段预算按 key 重算，不能让 N 把 key 各吃满一次段预算。
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
      totalBudgetMs: 2_600,
      tavilyTimeoutMs: 2_000,
    }));
    await assert.rejects(() => router.fetch({ url: 'https://example.com/a' }), () => true);
    assert.equal(stub.calls.length, 1);
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



test('search: legacy searchProviderOrder bridges in when providerOrder is at its default', async () => {
  const calls = [];
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run({ apiKey, request }) { calls.push({ apiKey, q: request.query }); return { sources: [{ url: 'https://fake.example/legacy' }], truncated: false }; },
  };
  const config = {
    providerOrder: ['tavily', 'exa', 'firecrawl'], // 等于默认值
    searchProviderOrder: ['fake'], // 旧字段，迁移应生效
    fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000, searchFallback: false,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/legacy');
  assert.equal(calls.length, 1);
});

test('search: a non-default providerOrder overrides the legacy field', async () => {
  const calls = [];
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run({ apiKey, request }) { calls.push({ apiKey, q: request.query }); return { sources: [{ url: 'https://fake.example/order' }], truncated: false }; },
  };
  const config = {
    providerOrder: ['fake'], // 非默认 → 以新字段为准
    searchProviderOrder: ['ghost'],
    fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000, searchFallback: false,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/order');
  assert.equal(calls.length, 1);
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

// 注意：这条用例走的是宿主**真正的** HttpFetchProvider（lib/official.js 的
// createOfficialFetchProvider），它内部用 `const { fetch } = await import("undici")`
// 发请求（见 @deepseek-ai/dsh-web-fetch-http/lib/index.js:257）。undici 是宿主包的
// 运行时依赖（其 package.json dependencies 里写着 undici 8.11.2），**不是本插件的依赖**，
// 本仓库顶层也解析不到（`import.meta.resolve("undici")` 会 ERR_MODULE_NOT_FOUND）；
// 它能被解析，是因为我们加载了宿主实现。CI 的「Install host packages」步骤装
// @deepseek-ai/dsh-web-fetch-http@next 时会一并带入 undici，故 CI 可跑。
// 所以这是一条「依赖宿主实现」的集成测试，动机是覆盖 fetch 兜底的真实成功路径。
test('fetch: local http fallback returns a successful result when no provider has a key', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('local ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const config = {
      fetchFallback: true, cooldownMs: 60_000, httpTimeoutMs: 10_000, maxBodyChars: 100_000, totalBudgetMs: 45_000,
      tavilyApiKeyRefs: [], firecrawlApiKeyRefs: [], exaApiKeyRefs: [],
    };
    const ctx = fakeCtx({ credentials: fakeCredentials({}) });
    const router = createRouter(ctx, config);
    const result = await router.fetch({ url: `http://127.0.0.1:${port}/` }, undefined);
    assert.equal(result.statusCode, 200);
    assert.match(result.body.content, /local ok/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fetch: a newly registered backend is picked up via providerOrder with no code branch', async () => {
  const calls = [];
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run({ apiKey, request }) {
      calls.push({ apiKey, url: request.url });
      return {
        kind: 'result',
        result: {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text', content: 'from fake backend' },
          truncated: false,
        },
      };
    },
  };
  const config = {
    providerOrder: ['fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    fetchFallback: false,
    maxBodyChars: 100_000,
    totalBudgetMs: 45_000,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { fetchBackends: { fake: fakeBackend } });
  const result = await router.fetch({ url: 'https://fake.example/x' }, undefined);
  assert.equal(result.body.content, 'from fake backend');
  assert.deepEqual(calls, [{ apiKey: 'fk', url: 'https://fake.example/x' }]);
});

test('fetch: a backend returning unusable hands over to the next one without penalizing its key', async () => {
  const seen = [];
  const emptyBackend = {
    id: 'empty',
    label: 'Empty',
    keyRefsField: 'emptyApiKeyRefs',
    timeoutField: 'emptyTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run() {
      seen.push('empty');
      return { kind: 'unusable', reason: 'nothing here' };
    },
  };
  const goodBackend = {
    id: 'good',
    label: 'Good',
    keyRefsField: 'goodApiKeyRefs',
    timeoutField: 'goodTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run({ request }) {
      seen.push('good');
      return {
        kind: 'result',
        result: {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text', content: 'second time lucky' },
          truncated: false,
        },
      };
    },
  };
  const config = {
    providerOrder: ['empty', 'good'],
    emptyApiKeyRefs: ['EMPTY_KEY'],
    goodApiKeyRefs: ['GOOD_KEY'],
    emptyTimeoutMs: 5_000,
    goodTimeoutMs: 5_000,
    cooldownMs: 60_000,
    fetchFallback: false,
    maxBodyChars: 100_000,
    totalBudgetMs: 45_000,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ EMPTY_KEY: 'e', GOOD_KEY: 'g' }) });
  const router = createRouter(ctx, config, { fetchBackends: { empty: emptyBackend, good: goodBackend } });
  const result = await router.fetch({ url: 'https://fake.example/y' }, undefined);
  assert.equal(result.body.content, 'second time lucky');
  assert.deepEqual(seen, ['empty', 'good']);
});

test('fetch: a keyless backend that reports itself unavailable is skipped, not called', async () => {
  const seen = [];
  const unavailable = {
    id: 'selfhosted',
    label: 'Self hosted',
    keyRefsField: null,
    timeoutField: 'selfHostedTimeoutMs',
    defaultTimeoutMs: 5_000,
    isAvailable() {
      return false;
    },
    async run() {
      seen.push('selfhosted');
      throw new Error('must not be called');
    },
  };
  const config = {
    providerOrder: ['selfhosted'],
    fetchFallback: false,
    maxBodyChars: 100_000,
    totalBudgetMs: 45_000,
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, config, { fetchBackends: { selfhosted: unavailable } });
  await assert.rejects(
    () => router.fetch({ url: 'https://fake.example/z' }, undefined),
    /no web fetch provider is usable/,
  );
  assert.deepEqual(seen, [], 'an unavailable backend must never be invoked');
});

test('fetch: a keyless backend reporting unusable hands over instead of returning undefined', async () => {
  const empty = {
    id: 'emptykeyless',
    label: 'Empty keyless',
    keyRefsField: null,
    timeoutField: 'emptyTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run() {
      return { kind: 'unusable', reason: 'nothing to extract' };
    },
  };
  const good = {
    id: 'goodkeyless',
    label: 'Good keyless',
    keyRefsField: null,
    timeoutField: 'goodTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run({ request }) {
      return {
        kind: 'result',
        result: {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text', content: 'fallback body' },
          truncated: false,
        },
      };
    },
  };
  const config = { providerOrder: ['emptykeyless', 'goodkeyless'], fetchFallback: false, maxBodyChars: 100_000, totalBudgetMs: 45_000 };
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, config, { fetchBackends: { emptykeyless: empty, goodkeyless: good } });
  const result = await router.fetch({ url: 'https://fake.example/k' }, undefined);
  assert.equal(result.body.content, 'fallback body');
});

test('search: an explicitly emptied providerOrder is not resurrected by the legacy field', async () => {
  // schema 默认值是三项，所以空数组只可能来自用户把供应商全部停用。
  // 此时旧字段不能把它救回来——否则「全部停用」重启后又变成旧顺序。
  const config = {
    providerOrder: [], // 用户全部停用
    searchProviderOrder: ['fake'], // 旧字段仍有值
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
  };
  const calls = [];
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run() { calls.push('fake'); return { sources: [{ url: 'https://fake.example/x' }], truncated: false }; },
  };
  const ctx = fakeCtx({ credentials: fakeCredentials({ FAKE_KEY: 'fk' }) });
  const router = createRouter(ctx, config, { searchBackends: { fake: fakeBackend } });
  await assert.rejects(() => router.search({ query: 'q' }, undefined), /no web search provider is usable/);
  assert.deepEqual(calls, [], 'a disabled provider must not be used');
});

test('fetch: a Firecrawl 200 without data does not cool down the whole key pool', async () => {
  // 上游 200 但响应体缺 data 是**请求级**异常（反爬拦截等）。若抛错，执行层的 keyed
  // catch 会把它当成「这把 key 坏了」，一次软错误就让该供应商整个冷却周期不可用。
  let calls = 0;
  const stub = stubFetch((url) => {
    calls += 1;
    if (url.includes('firecrawl.dev')) return Response.json({ success: false, error: 'blocked by anti-bot' });
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ F1: 'a', F2: 'b' }) });
    const router = createRouter(
      ctx,
      configWith({ providerOrder: ['firecrawl'], firecrawlApiKeyRefs: ['F1', 'F2'] }),
    );
    await assert.rejects(() => router.fetch({ url: 'https://example.com/a' }, undefined), /no page data|empty body/);
    const afterFirst = calls;
    assert.equal(afterFirst, 1, '缺 data 时不该在同一次调用里试第二把 key（与 key 无关）');
    await assert.rejects(() => router.fetch({ url: 'https://example.com/a' }, undefined), /no page data|empty body/);
    assert.equal(calls, afterFirst + 1, '两把 key 都必须仍可用：第二轮要能再次触网');
  } finally {
    stub.restore();
  }
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

test('fetch: a keyless backend that throws is recorded as a failure and reported', async () => {
  const keyless = {
    id: 'fkless', label: 'FK', keyRefsField: null, timeoutField: null, defaultTimeoutMs: 5_000,
    async run() { throw new Error('kaboom-fetch'); },
  };
  const config = { providerOrder: ['fkless'], fetchFallback: false, maxBodyChars: 100_000, totalBudgetMs: 45_000 };
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, config, { fetchBackends: { fkless: keyless } });
  await assert.rejects(() => router.fetch({ url: 'https://fake.example/e' }, undefined), /kaboom-fetch/);
});

test('fetch: an aborted keyless backend surfaces as WEB_ABORTED, not a backend failure', async () => {
  const keyless = {
    id: 'fkless', label: 'FK', keyRefsField: null, timeoutField: null, defaultTimeoutMs: 5_000,
    async run() { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  };
  const config = { providerOrder: ['fkless'], fetchFallback: false, maxBodyChars: 100_000, totalBudgetMs: 45_000 };
  const ctx = fakeCtx({ credentials: fakeCredentials({}) });
  const router = createRouter(ctx, config, { fetchBackends: { fkless: keyless } });
  await assert.rejects(
    () => router.fetch({ url: 'https://fake.example/e' }, undefined),
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

test('note: a throwing logger never breaks the request', async () => {
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run() { return { sources: [{ url: 'https://fake.example/log' }], truncated: false }; },
  };
  const config = { providerOrder: ['fake'], fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000, searchFallback: false };
  const ctx = fakeCtx({
    credentials: fakeCredentials({ FAKE_KEY: 'fk' }),
    logger: { warn() {}, debug() { throw new Error('logger exploded'); }, info() { throw new Error('logger exploded'); } },
  });
  const router = createRouter(ctx, config, { searchBackends: { fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/log');
});
