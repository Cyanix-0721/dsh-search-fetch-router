import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRouter } from '../lib/execute.js';

import { fakeCtx, fakeCredentials, stubFetch, configWith } from './helpers/execute-harness.js';

function tavilyResponder() {
  return () => Response.json({
    results: [{ url: 'https://a.example.com', title: 'A', content: 'snip' }],
    answer: 'answer',
  });
}

test('cache: a repeated identical search is served from cache without a second call', async () => {
  const stub = stubFetch(tavilyResponder());
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    const first = await router.search({ query: 'q', maxResults: 5 }, undefined);
    const second = await router.search({ query: 'q', maxResults: 5 }, undefined);
    assert.equal(stub.calls.length, 1, 'second identical search must hit the cache, not the network');
    assert.deepEqual(second, first);
    assert.equal(second.content, 'answer');
  } finally {
    stub.restore();
  }
});

test('cache: cacheEnabled=false bypasses the cache entirely', async () => {
  const stub = stubFetch(tavilyResponder());
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({ cacheEnabled: false }));
    await router.search({ query: 'q' }, undefined);
    await router.search({ query: 'q' }, undefined);
    assert.equal(stub.calls.length, 2, 'with cache off every search reaches the network');
  } finally {
    stub.restore();
  }
});

test('cache: a different query is not served from another query\'s cache entry', async () => {
  const stub = stubFetch(tavilyResponder());
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    await router.search({ query: 'alpha' }, undefined);
    await router.search({ query: 'beta' }, undefined);
    assert.equal(stub.calls.length, 2, 'distinct queries must not share a cache key');
  } finally {
    stub.restore();
  }
});

test('cache: cached results are already stripped of lone surrogates', async () => {
  const stub = stubFetch(() => Response.json({
    results: [{ url: 'https://a.example.com', title: 'A\uD83D', content: 'x\uDC33y' }],
  }));
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    const result = await router.search({ query: 'q' }, undefined);
    assert.equal(result.sources[0].title, 'A');
    assert.equal(result.sources[0].snippet, 'xy');
  } finally {
    stub.restore();
  }
});

test('cache: mutating the first result does not poison the cached entry', async () => {
  const stub = stubFetch(tavilyResponder());
  try {
    const ctx = fakeCtx({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    const router = createRouter(ctx, configWith({}));
    const first = await router.search({ query: 'q' }, undefined);
    // Caller scribbles over the object it got back.
    first.sources[0].url = 'MUTATED';
    first.content = 'MUTATED';
    const second = await router.search({ query: 'q' }, undefined);
    assert.equal(stub.calls.length, 1, 'second call must be a cache hit, not a network call');
    assert.equal(second.sources[0].url, 'https://a.example.com', 'cached entry must not carry the caller mutation');
    assert.equal(second.content, 'answer');
  } finally {
    stub.restore();
  }
});
