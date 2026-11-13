import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractTavily, searchTavily } from '../lib/tavily.js';

/**
 * 用一个假的 `fetch` 替换全局，记录调用参数并回放给定响应。
 * @param responder - `(url, init) => Response`。
 * @returns 还原函数与调用记录。
 */
function stubFetch(responder) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const options = { signal: undefined, timeoutMs: 5_000 };

test('search: maps results into seam sources', async () => {
  const stub = stubFetch(() => Response.json({
    results: [
      { url: 'https://a.example.com', title: 'A', content: 'snippet a', published_date: '2026-01-01' },
      { url: 'https://b.example.com' },
      { title: 'no url, dropped' },
    ],
    answer: 'the answer',
  }));
  try {
    const result = await searchTavily({ apiKey: 'k', query: 'q', maxResults: 5, ...options });
    assert.equal(result.content, 'the answer');
    assert.equal(result.truncated, false);
    assert.equal(result.sources.length, 2);
    assert.deepEqual(result.sources[0], {
      url: 'https://a.example.com',
      title: 'A',
      snippet: 'snippet a',
      publishedAt: '2026-01-01',
    });
    assert.deepEqual(result.sources[1], { url: 'https://b.example.com' });
  } finally {
    stub.restore();
  }
});

test('search: sends the bearer token and the query', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    await searchTavily({ apiKey: 'fc-FAKE-TEST-KEY', query: 'hello', maxResults: 3, ...options });
    const [call] = stub.calls;
    assert.equal(call.url, 'https://api.tavily.com/search');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer fc-FAKE-TEST-KEY');
    const body = JSON.parse(call.init.body);
    assert.equal(body.query, 'hello');
    assert.equal(body.max_results, 3);
  } finally {
    stub.restore();
  }
});

test('search: omits max_results when the caller did not ask for a limit', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    await searchTavily({ apiKey: 'k', query: 'q', maxResults: undefined, ...options });
    assert.equal('max_results' in JSON.parse(stub.calls[0].init.body), false);
  } finally {
    stub.restore();
  }
});

test('search: a non-2xx response throws with the status attached', async () => {
  const stub = stubFetch(() => new Response('bad key', { status: 401 }));
  try {
    await assert.rejects(
      () => searchTavily({ apiKey: 'k', query: 'q', ...options }),
      (error) => {
        assert.equal(error.status, 401);
        assert.match(error.message, /HTTP 401/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('search: a non-JSON body throws', async () => {
  const stub = stubFetch(() => new Response('<html>', { status: 200 }));
  try {
    await assert.rejects(() => searchTavily({ apiKey: 'k', query: 'q', ...options }), /not JSON/);
  } finally {
    stub.restore();
  }
});

test('extract: returns raw_content on success', async () => {
  const stub = stubFetch(() => Response.json({
    results: [{ url: 'https://example.com', raw_content: '# hello' }],
    failed_results: [],
  }));
  try {
    const result = await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', ...options });
    assert.equal(result.content, '# hello');
    assert.deepEqual(result.failed, []);
  } finally {
    stub.restore();
  }
});

test('extract: HTTP 200 with an empty results array is a failure, not a success', async () => {
  const stub = stubFetch(() => Response.json({ results: [], failed_results: [{ url: 'https://example.com', error: 'blocked' }] }));
  try {
    const result = await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', ...options });
    assert.equal(result.content, '');
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].error, 'blocked');
  } finally {
    stub.restore();
  }
});

test('extract: an empty payload with neither results nor failures is treated as a failure', async () => {
  const stub = stubFetch(() => Response.json({}));
  try {
    const result = await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', ...options });
    assert.equal(result.content, '');
    assert.equal(result.failed.length, 1);
  } finally {
    stub.restore();
  }
});

test('extract: advanced depth is forwarded, basic is left implicit', async () => {
  const stub = stubFetch(() => Response.json({ results: [{ raw_content: 'x' }], failed_results: [] }));
  try {
    await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'advanced', ...options });
    assert.equal(JSON.parse(stub.calls[0].init.body).extract_depth, 'advanced');

    await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', ...options });
    assert.equal('extract_depth' in JSON.parse(stub.calls[1].init.body), false);
  } finally {
    stub.restore();
  }
});

test('extract: the request carries exactly one url', async () => {
  const stub = stubFetch(() => Response.json({ results: [{ raw_content: 'x' }], failed_results: [] }));
  try {
    await extractTavily({ apiKey: 'k', url: 'https://example.com/a', depth: 'basic', ...options });
    assert.deepEqual(JSON.parse(stub.calls[0].init.body).urls, ['https://example.com/a']);
  } finally {
    stub.restore();
  }
});

test('extract: the local budget is forwarded as a server-side timeout in seconds', async () => {
  const stub = stubFetch(() => Response.json({ results: [{ raw_content: 'x' }], failed_results: [] }));
  try {
    await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', signal: undefined, timeoutMs: 12_500 });
    assert.equal(JSON.parse(stub.calls[0].init.body).timeout, 12);

    // 官方范围是 1.0–60.0，越界会被 400 拒；所以夹取而不是原样透传。
    await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', signal: undefined, timeoutMs: 120_000 });
    assert.equal(JSON.parse(stub.calls[1].init.body).timeout, 60);

    await extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', signal: undefined, timeoutMs: 200 });
    assert.equal(JSON.parse(stub.calls[2].init.body).timeout, 1);
  } finally {
    stub.restore();
  }
});

test('a 429 carries the Retry-After header so the ring can honour it', async () => {
  const stub = stubFetch(() => new Response('slow down', {
    status: 429,
    headers: { 'retry-after': '90' },
  }));
  try {
    await assert.rejects(
      () => extractTavily({ apiKey: 'k', url: 'https://example.com', depth: 'basic', ...options }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 90_000);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('a response without Retry-After leaves the hint unset', async () => {
  const stub = stubFetch(() => new Response('boom', { status: 500 }));
  try {
    await assert.rejects(
      () => searchTavily({ apiKey: 'k', query: 'q', ...options }),
      (error) => {
        assert.equal('retryAfterMs' in error, false);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('search: max_results is clamped to the documented 20', async () => {
  const stub = stubFetch(() => Response.json({ results: [] }));
  try {
    await searchTavily({ apiKey: 'k', query: 'q', maxResults: 50, ...options });
    assert.equal(JSON.parse(stub.calls[0].init.body).max_results, 20);

    await searchTavily({ apiKey: 'k', query: 'q', maxResults: 7, ...options });
    assert.equal(JSON.parse(stub.calls[1].init.body).max_results, 7);
  } finally {
    stub.restore();
  }
});
