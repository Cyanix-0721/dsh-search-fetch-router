import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Config } from '../lib/config.js';
import { createRouter } from '../lib/execute.js';

/**
 * 造一个最小 ctx。只提供插件真正读的三样：`credentials`、`launchEnvironment`、`logger`。
 * @param options - `{credentials}`。
 * @returns 假 ctx。
 */
function fakeCtx({ credentials } = {}) {
  return {
    get(name) {
      if (name === 'credentials') return credentials;
      return undefined;
    },
    logger: { warn() {} },
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
