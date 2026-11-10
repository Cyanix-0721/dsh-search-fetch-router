import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEEPSEEK_DEFAULT_BASE_URL } from '@deepseek-ai/dsh-web-search-deepseek';

import { Config } from '../lib/config.js';
import { createRouter } from '../lib/execute.js';

/**
 * 造一个最小 ctx。只提供插件真正读的四样：`credentials`、`settings`、
 * `launchEnvironment`（未提供时 `launchEnvironmentOf` 会安全跳过）、`logger`。
 * @param options - `{credentials, settings}`。
 * @returns 假 ctx。
 */
function fakeCtx({ credentials, settings } = {}) {
  return {
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'settings') return settings;
      return undefined;
    },
    logger: { warn() {} },
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

test('fetch: a whitelisted URL skips Tavily entirely', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('firecrawl.dev')) {
      return Response.json({ data: { markdown: '# whitelisted', metadata: {} } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const ctx = fakeCtx({
      credentials: fakeCredentials({ TAVILY_API_KEY: 'k', FIRECRAWL_API_KEY: 'f' }),
    });
    const router = createRouter(ctx, configWith({ firecrawlUrlPatterns: ['example.com/**'] }));
    const result = await router.fetch({ url: 'https://example.com/a' }, undefined);
    assert.equal(result.body.content, '# whitelisted');
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /firecrawl/);
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
      assert.match(error.message, /no Tavily or Firecrawl key reference is configured/);
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

test('fetch: a whitelisted URL with no Firecrawl key falls back to Tavily instead of idling', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/extract')) {
      return Response.json({ results: [{ raw_content: '# tavily handled whitelist' }], failed_results: [] });
    }
    return Response.json({ data: { markdown: '# should not use firecrawl', metadata: {} } });
  });
  try {
    // 白名单命中但只配了 Tavily key：链应降到 Tavily，而不是直接失败。
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({ firecrawlUrlPatterns: ['example.com/**'] }));
    const result = await router.fetch({ url: 'https://example.com/a' }, undefined);
    assert.match(result.body.content, /tavily handled whitelist/);
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /tavily/);
  } finally {
    stub.restore();
  }
});
