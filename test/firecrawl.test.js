import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildScrapeBody, mapScrapeResponse, searchFirecrawl } from '../lib/firecrawl.js';

/** 替换 globalThis.fetch，记录调用，测试后恢复。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : String(url);
    calls.push({ url: href, init });
    return handler(href, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('body: markdown only, with the configured knobs', () => {
  const body = buildScrapeBody('https://example.com/a', {
    onlyMainContent: true,
    maxAgeMs: 172_800_000,
    timeoutMs: 30_000,
  });
  assert.deepEqual(body, {
    url: 'https://example.com/a',
    formats: ['markdown'],
    onlyMainContent: true,
    maxAge: 172_800_000,
    timeout: 30_000,
  });
});

test('map: markdown becomes a text body', () => {
  const result = mapScrapeResponse(
    { data: { markdown: '# Title\n\nBody', metadata: { statusCode: 200, url: 'https://example.com/a' } } },
    'https://example.com/a',
    { maxBodyChars: 100_000 },
  );
  assert.equal(result.body.kind, 'text');
  assert.equal(result.body.content, '# Title\n\nBody');
  assert.equal(result.truncated, false);
  assert.equal(result.statusCode, 200);
});

test('map: missing data is reported as a request-level failure, not thrown', () => {
  // 抛错会被执行层的 keyed catch 当成「这把 key 坏了」，一次上游软错误就把整池 key
  // 打进冷却。缺 data 是请求级异常，必须走 unusable 分支。
  const mapped = mapScrapeResponse({ success: false, error: 'blocked by anti-bot' }, 'https://example.com', {
    maxBodyChars: 10,
  });
  assert.equal(mapped.missing, true);
  assert.match(mapped.failure, /blocked by anti-bot/);
});

test('map: missing data without an upstream reason still names what is missing', () => {
  const mapped = mapScrapeResponse({}, 'https://example.com', { maxBodyChars: 10 });
  assert.equal(mapped.missing, true);
  assert.match(mapped.failure, /response\.data is missing/);
});

test('map: over-long bodies are truncated', () => {
  const result = mapScrapeResponse(
    { data: { markdown: 'a'.repeat(50), metadata: {} } },
    'https://example.com',
    { maxBodyChars: 10 },
  );
  assert.equal(result.truncated, true);
  assert.equal(result.body.content.length, 10);
});

test('map: a missing statusCode falls back to 200', () => {
  const result = mapScrapeResponse({ data: { markdown: 'x', metadata: {} } }, 'https://example.com', { maxBodyChars: 10 });
  assert.equal(result.statusCode, 200);
});

test('map: a non-integer statusCode falls back to 200', () => {
  const result = mapScrapeResponse(
    { data: { markdown: 'x', metadata: { statusCode: '404' } } },
    'https://example.com',
    { maxBodyChars: 10 },
  );
  assert.equal(result.statusCode, 200);
});

test('map: the resolved URL prefers metadata.url, then sourceURL, then the request', () => {
  const fromMeta = mapScrapeResponse(
    { data: { markdown: 'x', metadata: { url: 'https://final.example.com', sourceURL: 'https://source.example.com' } } },
    'https://requested.example.com',
    { maxBodyChars: 10 },
  );
  assert.equal(fromMeta.url, 'https://final.example.com');

  const fromSource = mapScrapeResponse(
    { data: { markdown: 'x', metadata: { sourceURL: 'https://source.example.com' } } },
    'https://requested.example.com',
    { maxBodyChars: 10 },
  );
  assert.equal(fromSource.url, 'https://source.example.com');

  const fromRequest = mapScrapeResponse(
    { data: { markdown: 'x', metadata: {} } },
    'https://requested.example.com',
    { maxBodyChars: 10 },
  );
  assert.equal(fromRequest.url, 'https://requested.example.com');
});

test('map: reads the upstream failure reason from metadata.error, then warning', () => {
  // 抓取被拦/超时时 Firecrawl 仍可能 200，把原因放在 metadata.error 或顶层 warning。
  // 不读它的话，报错只剩一句 empty body，无法区分「页面空」和「被拦」。
  const fromMeta = mapScrapeResponse(
    { data: { markdown: '', metadata: { error: 'Blocked by anti-bot' } } },
    'https://example.com',
    { maxBodyChars: 10 },
  );
  assert.equal(fromMeta.failure, 'Blocked by anti-bot');

  const fromWarning = mapScrapeResponse(
    { data: { markdown: '', warning: 'timed out' , metadata: {} } },
    'https://example.com',
    { maxBodyChars: 10 },
  );
  assert.equal(fromWarning.failure, 'timed out');

  const clean = mapScrapeResponse({ data: { markdown: 'x', metadata: {} } }, 'https://example.com', { maxBodyChars: 10 });
  assert.equal(clean.failure, undefined);
});

test('build body: clamps timeout into the documented 1000..300000 range', () => {
  // 越界上游直接 400；段预算可能很小，必须夹住。
  const tiny = buildScrapeBody('https://example.com/a', { onlyMainContent: true, maxAgeMs: 1, timeoutMs: 10 });
  assert.equal(tiny.timeout, 1_000);
  const huge = buildScrapeBody('https://example.com/a', { onlyMainContent: true, maxAgeMs: 1, timeoutMs: 10_000_000 });
  assert.equal(huge.timeout, 300_000);
});

test('map: a missing markdown field becomes an empty body', () => {
  const result = mapScrapeResponse({ data: { metadata: {} } }, 'https://example.com', { maxBodyChars: 10 });
  assert.equal(result.body.content, '');
});

test('search: posts query + limit and maps data.web into sources', async () => {
  const stub = stubFetch(() =>
    Response.json({
      success: true,
      data: {
        web: [
          { title: 'Alpha', url: 'https://a.example', description: 'first' },
          { title: 'Beta', url: 'https://b.example', markdown: '# Body' },
          { noUrl: true },
        ],
      },
    }),
  );
  try {
    const result = await searchFirecrawl({ apiKey: 'fc-key', query: 'hello', maxResults: 5, timeoutMs: 1_000 });
    assert.deepEqual(result, {
      sources: [
        { url: 'https://a.example', title: 'Alpha', snippet: 'first' },
        { url: 'https://b.example', title: 'Beta', snippet: '# Body' },
      ],
      truncated: false,
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.match(stub.calls[0].url, /api\.firecrawl\.dev\/v2\/search$/);
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer fc-key');
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.query, 'hello');
    assert.equal(body.limit, 5);
  } finally {
    stub.restore();
  }
});

test('search: clamps limit to the documented maximum of 100', async () => {
  const stub = stubFetch(() => Response.json({ success: true, data: { web: [] } }));
  try {
    await searchFirecrawl({ apiKey: 'fc-key', query: 'q', maxResults: 500, timeoutMs: 1_000 });
    assert.equal(JSON.parse(stub.calls[0].init.body).limit, 100);
  } finally {
    stub.restore();
  }
});

test('search: an empty web array yields empty sources, not an error', async () => {
  const stub = stubFetch(() => Response.json({ success: true, data: { web: [] } }));
  try {
    const result = await searchFirecrawl({ apiKey: 'fc-key', query: 'q', timeoutMs: 1_000 });
    assert.deepEqual(result, { sources: [], truncated: false });
  } finally {
    stub.restore();
  }
});

test('search: a non-2xx response throws with the HTTP status', async () => {
  const stub = stubFetch(() => new Response('bad', { status: 402 }));
  try {
    await assert.rejects(
      searchFirecrawl({ apiKey: 'fc-key', query: 'q', timeoutMs: 1_000 }),
      (error) => {
        assert.match(error.message, /HTTP 402/);
        assert.equal(error.status, 402);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('search: prefers highlights over description, because that is what the API returns by default', async () => {
  const stub = stubFetch(() => Response.json({
    success: true,
    data: {
      web: [
        {
          title: 'Alpha',
          url: 'https://a.example',
          description: 'plain description',
          highlights: ['query-relevant passage'],
        },
      ],
    },
  }));
  try {
    const result = await searchFirecrawl({ apiKey: 'fc-key', query: 'q', timeoutMs: 1_000 });
    // 默认响应带 highlights；description 只在 highlights:false 时才有，优先级必须反过来。
    assert.equal(result.sources[0].snippet, 'query-relevant passage');
  } finally {
    stub.restore();
  }
});

test('search: tolerates data being a bare array as well as {web: [...]}', async () => {
  const stub = stubFetch(() => Response.json({
    success: true,
    data: [{ title: 'Alpha', url: 'https://a.example', description: 'first' }],
  }));
  try {
    const result = await searchFirecrawl({ apiKey: 'fc-key', query: 'q', timeoutMs: 1_000 });
    // 两种形状都认：一次 API 形状变化不该把整条搜索链打空。
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, 'https://a.example');
  } finally {
    stub.restore();
  }
});

test('search: clamps the server-side timeout into 1000..300000 too', async () => {
  // 搜索这条曾经直接透传段预算：段预算只剩几百毫秒时 body.timeout 会是 200，
  // 上游回 400，看起来像「Firecrawl 挂了」，其实是我们发了非法请求。
  const stub = stubFetch(() => Response.json({ success: true, data: { web: [] } }));
  try {
    await searchFirecrawl({ apiKey: 'fc-key', query: 'q', timeoutMs: 200 });
    assert.equal(JSON.parse(stub.calls[0].init.body).timeout, 1_000);
    await searchFirecrawl({ apiKey: 'fc-key', query: 'q', timeoutMs: 10_000_000 });
    assert.equal(JSON.parse(stub.calls[1].init.body).timeout, 300_000);
  } finally {
    stub.restore();
  }
});

test('search: passes the server-side timeout so Firecrawl gives up before we disconnect', async () => {
  const stub = stubFetch(() => Response.json({ success: true, data: { web: [] } }));
  try {
    await searchFirecrawl({ apiKey: 'fc-key', query: 'q', timeoutMs: 7_000 });
    assert.equal(JSON.parse(stub.calls[0].init.body).timeout, 7_000);
  } finally {
    stub.restore();
  }
});
