import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXA_SEARCH_TYPES, contentsExa, normalizeSearchType, searchExa } from '../lib/exa.js';

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

test('exa: posts the query and maps results into sources', async () => {
  const stub = stubFetch(() =>
    Response.json({
      results: [
        { title: 'Alpha', url: 'https://a.example', text: 'first snippet', publishedDate: '2024-01-02T00:00:00Z' },
        { title: 'Beta', url: 'https://b.example' },
        { noUrl: true },
      ],
    }),
  );
  try {
    const result = await searchExa({ apiKey: 'ek', query: 'hello', maxResults: 5, timeoutMs: 1_000 });
    assert.deepEqual(result, {
      sources: [
        { url: 'https://a.example', title: 'Alpha', snippet: 'first snippet', publishedAt: '2024-01-02T00:00:00Z' },
        { url: 'https://b.example', title: 'Beta' },
      ],
      truncated: false,
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.match(stub.calls[0].url, /api\.exa\.ai\/search$/);
    assert.equal(stub.calls[0].init.headers['x-api-key'], 'ek');
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.query, 'hello');
    assert.equal(body.numResults, 5);
    assert.equal(body.type, 'auto');
    assert.equal(body.contents.text.maxCharacters, 1000);
  } finally {
    stub.restore();
  }
});

test('exa: clamps numResults to the documented maximum of 100', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    await searchExa({ apiKey: 'ek', query: 'q', maxResults: 500, timeoutMs: 1_000 });
    assert.equal(JSON.parse(stub.calls[0].init.body).numResults, 100);
  } finally {
    stub.restore();
  }
});

test('exa: an empty result set yields empty sources, not an error', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    const result = await searchExa({ apiKey: 'ek', query: 'q', timeoutMs: 1_000 });
    assert.deepEqual(result, { sources: [], truncated: false });
  } finally {
    stub.restore();
  }
});

test('exa: a non-2xx response throws with the HTTP status', async () => {
  const stub = stubFetch(() => new Response('unauthorized', { status: 401 }));
  try {
    await assert.rejects(
      searchExa({ apiKey: 'bad', query: 'q', timeoutMs: 1_000 }),
      (error) => {
        assert.match(error.message, /HTTP 401/);
        assert.equal(error.status, 401);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('exa: a non-JSON body throws a stable error', async () => {
  const stub = stubFetch(() => new Response('not json', { status: 200 }));
  try {
    await assert.rejects(
      searchExa({ apiKey: 'ek', query: 'q', timeoutMs: 1_000 }),
      /not JSON/,
    );
  } finally {
    stub.restore();
  }
});

test('exa contents: posts the url and returns the first result text', async () => {
  const stub = stubFetch(() =>
    Response.json({ results: [{ url: 'https://a.example', text: '# Hello\nBody' }] }),
  );
  try {
    const { content } = await contentsExa({ apiKey: 'ek', url: 'https://a.example', timeoutMs: 1_000, maxBodyChars: 5_000 });
    assert.equal(content, '# Hello\nBody');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.match(stub.calls[0].url, /api\.exa\.ai\/contents$/);
    assert.equal(stub.calls[0].init.headers['x-api-key'], 'ek');
    const body = JSON.parse(stub.calls[0].init.body);
    assert.deepEqual(body.urls, ['https://a.example']);
    assert.equal(body.text.maxCharacters, 5_000);
  } finally {
    stub.restore();
  }
});

test('exa contents: an empty result set yields empty content, not an error', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    const { content } = await contentsExa({ apiKey: 'ek', url: 'https://a.example', timeoutMs: 1_000 });
    assert.equal(content, '');
  } finally {
    stub.restore();
  }
});

test('exa contents: a non-2xx response throws with the HTTP status', async () => {
  const stub = stubFetch(() => new Response('nope', { status: 500 }));
  try {
    await assert.rejects(
      contentsExa({ apiKey: 'ek', url: 'https://a.example', timeoutMs: 1_000 }),
      (error) => {
        assert.match(error.message, /HTTP 500/);
        assert.equal(error.status, 500);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('exa: forwards the configured search type', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    await searchExa({ apiKey: 'ek', query: 'q', timeoutMs: 1_000, type: 'fast' });
    assert.equal(JSON.parse(stub.calls[0].init.body).type, 'fast');
  } finally {
    stub.restore();
  }
});

test('exa: an unknown search type falls back to auto instead of failing upstream', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    await searchExa({ apiKey: 'ek', query: 'q', timeoutMs: 1_000, type: 'nope' });
    assert.equal(JSON.parse(stub.calls[0].init.body).type, 'auto');
  } finally {
    stub.restore();
  }
});

test('exa: normalizeSearchType accepts only the documented values', () => {
  for (const type of EXA_SEARCH_TYPES) assert.equal(normalizeSearchType(type), type);
  assert.equal(normalizeSearchType(undefined), 'auto');
  assert.equal(normalizeSearchType(''), 'auto');
  assert.equal(normalizeSearchType('AUTO'), 'auto');
  assert.equal(normalizeSearchType(42), 'auto');
  // 手改配置常带空格：trim 后合法就照用，而不是悄悄退回 auto 让用户以为档位没生效。
  assert.equal(normalizeSearchType(' deep-lite '), 'deep-lite');
  assert.equal(normalizeSearchType('  '), 'auto');
});
