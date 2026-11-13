import assert from 'node:assert/strict';
import { test } from 'node:test';

import { searchBrave } from '../lib/brave.js';

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

test('brave: maps web.results into sources and sends the subscription header', async () => {
  const stub = stubFetch(() =>
    Response.json({
      web: {
        results: [
          { title: 'Alpha', url: 'https://a.example', description: 'first snippet', extra_snippets: ['x'] },
          { title: 'Beta', url: 'https://b.example', description: '' },
          { url: 42 },
        ],
      },
    }),
  );
  try {
    const result = await searchBrave({ apiKey: 'bk', query: 'hello', maxResults: 5, timeoutMs: 1_000 });
    assert.deepEqual(result, {
      sources: [
        { url: 'https://a.example', title: 'Alpha', snippet: 'first snippet' },
        { url: 'https://b.example', title: 'Beta' },
      ],
      truncated: false,
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].init.headers['x-subscription-token'], 'bk');
    assert.equal(stub.calls[0].init.headers.accept, 'application/json');
    assert.match(stub.calls[0].url, /\/res\/v1\/web\/search\?/);
    assert.match(stub.calls[0].url, /q=hello/);
    assert.match(stub.calls[0].url, /count=5/);
  } finally {
    stub.restore();
  }
});

test('brave: clamps count to the documented maximum of 20', async () => {
  const stub = stubFetch(() => Response.json({ web: { results: [] } }));
  try {
    await searchBrave({ apiKey: 'bk', query: 'q', maxResults: 50, timeoutMs: 1_000 });
    assert.match(stub.calls[0].url, /count=20/);
  } finally {
    stub.restore();
  }
});

test('brave: an empty result set yields empty sources, not an error', async () => {
  const stub = stubFetch(() => Response.json({ web: { results: [] } }));
  try {
    const result = await searchBrave({ apiKey: 'bk', query: 'q', timeoutMs: 1_000 });
    assert.deepEqual(result, { sources: [], truncated: false });
  } finally {
    stub.restore();
  }
});

test('brave: a non-2xx response throws with the HTTP status', async () => {
  const stub = stubFetch(() => new Response('invalid token', { status: 401 }));
  try {
    await assert.rejects(
      searchBrave({ apiKey: 'bad', query: 'q', timeoutMs: 1_000 }),
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

test('brave: a non-JSON body throws a stable error', async () => {
  const stub = stubFetch(() => new Response('not json', { status: 200 }));
  try {
    await assert.rejects(
      searchBrave({ apiKey: 'bk', query: 'q', timeoutMs: 1_000 }),
      /not JSON/,
    );
  } finally {
    stub.restore();
  }
});
