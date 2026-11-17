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

test('fetch: enabled=false bypasses every configured key and needs the local fallback', async () => {
  const stub = stubFetch(() => {
    throw new Error('disabled router must not touch the network');
  });
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({ enabled: false, fetchFallback: false }));
    await assert.rejects(
      () => router.fetch({ url: 'https://example.com/a' }, undefined),
      /no web fetch provider is usable/,
    );
    assert.equal(stub.calls.length, 0, 'disabled router must not call any provider');
  } finally {
    stub.restore();
  }
});
