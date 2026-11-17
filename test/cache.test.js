import test from 'node:test';
import assert from 'node:assert/strict';

import { ResultCache, cacheSignature, buildSearchCacheKey, buildFetchCacheKey } from '../lib/cache.js';

test('cache: stores and retrieves a value', () => {
  const cache = new ResultCache();
  cache.set('a', { x: 1 }, { ttlMs: 1000 }, 0);
  assert.deepEqual(cache.get('a', 500), { x: 1 });
  assert.equal(cache.get('missing', 500), undefined);
  assert.equal(cache.size, 1);
});

test('cache: entries expire once ttl elapses', () => {
  const cache = new ResultCache();
  cache.set('a', 1, { ttlMs: 1000 }, 0);
  assert.equal(cache.get('a', 999), 1, 'still alive just before expiry');
  assert.equal(cache.get('a', 1000), undefined, 'expired exactly at ttl');
  assert.equal(cache.size, 0, 'expired entry is removed on read');
});

test('cache: ttlMs <= 0 means it never expires', () => {
  const cache = new ResultCache();
  cache.set('a', 'forever', { ttlMs: 0 }, 0);
  assert.equal(cache.get('a', 10 ** 12), 'forever');
});

test('cache: evicts the least-recently-used entry when maxEntries is exceeded', () => {
  const cache = new ResultCache();
  cache.set('a', 1, { maxEntries: 2 }, 0);
  cache.set('b', 2, { maxEntries: 2 }, 0);
  // Touch 'a' so 'b' becomes the least-recently-used.
  assert.equal(cache.get('a', 0), 1);
  cache.set('c', 3, { maxEntries: 2 }, 0);
  assert.equal(cache.get('b', 0), undefined, 'b was evicted');
  assert.equal(cache.get('a', 0), 1);
  assert.equal(cache.get('c', 0), 3);
  assert.equal(cache.size, 2);
});

test('cache: maxEntries <= 0 disables storage entirely', () => {
  const cache = new ResultCache();
  cache.set('a', 1, { maxEntries: 0 }, 0);
  assert.equal(cache.get('a', 0), undefined);
  assert.equal(cache.size, 0);
});

test('cache: evicts by byte budget too', () => {
  const cache = new ResultCache();
  // Each value ~ JSON '"xxxx"' = 6 bytes. Budget 10 keeps only the newest one.
  cache.set('a', 'aaaa', { maxEntries: 10, maxBytes: 10 }, 0);
  cache.set('b', 'bbbb', { maxEntries: 10, maxBytes: 10 }, 0);
  assert.equal(cache.get('a', 0), undefined, 'oldest evicted to respect byte budget');
  assert.equal(cache.get('b', 0), 'bbbb');
  assert.ok(cache.bytes <= 10);
});

test('cache: clear drops everything and resets bytes', () => {
  const cache = new ResultCache();
  cache.set('a', { big: 'x'.repeat(20) }, {}, 0);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test('cacheSignature: stable regardless of object key order', () => {
  assert.equal(
    cacheSignature({ b: 2, a: 1 }),
    cacheSignature({ a: 1, b: 2 }),
  );
});

test('cacheSignature: encodes undefined as null and distinguishes values', () => {
  assert.equal(cacheSignature({ a: undefined }), '{"a":null}');
  assert.notEqual(cacheSignature({ a: 1 }), cacheSignature({ a: 2 }));
  assert.equal(cacheSignature(['x', 1, true]), '["x",1,true]');
});

const baseSearch = {
  query: 'whales', order: ['tavily', 'exa'], maxResults: 5, maxResultsMode: 'cap',
  maxSearchResults: 20, exaSearchType: 'auto', tavilySearchDepth: 'basic',
  tavilyTopic: 'general', generation: 0,
};

test('buildSearchCacheKey: every result-affecting field changes the key', () => {
  const base = buildSearchCacheKey(baseSearch);
  assert.equal(base, buildSearchCacheKey({ ...baseSearch }), 'same inputs → same key');
  const mutations = {
    query: 'dolphins', order: ['exa', 'tavily'], maxResults: 6, maxResultsMode: 'provider-max',
    maxSearchResults: 50, exaSearchType: 'keyword', tavilySearchDepth: 'advanced',
    tavilyTopic: 'news', generation: 1,
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(
      buildSearchCacheKey({ ...baseSearch, [field]: value }),
      base,
      `changing ${field} must change the search cache key`,
    );
  }
});

test('buildSearchCacheKey: trims query and treats missing/non-string as empty', () => {
  assert.equal(buildSearchCacheKey({ ...baseSearch, query: '  whales  ' }), buildSearchCacheKey(baseSearch));
  assert.equal(
    buildSearchCacheKey({ ...baseSearch, query: undefined }),
    buildSearchCacheKey({ ...baseSearch, query: '   ' }),
  );
});

const baseFetch = {
  url: 'https://a.example.com', order: ['tavily'], maxBodyChars: 100000,
  tavilyExtractDepth: 'basic', minContentChars: 0, firecrawlOnlyMainContent: true,
  firecrawlMaxAgeMs: 172800000, generation: 0,
};

test('buildFetchCacheKey: every result-affecting field changes the key', () => {
  const base = buildFetchCacheKey(baseFetch);
  assert.equal(base, buildFetchCacheKey({ ...baseFetch }));
  const mutations = {
    url: 'https://b.example.com', order: ['exa'], maxBodyChars: 500, tavilyExtractDepth: 'advanced',
    minContentChars: 100, firecrawlOnlyMainContent: false, firecrawlMaxAgeMs: 0, generation: 3,
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(
      buildFetchCacheKey({ ...baseFetch, [field]: value }),
      base,
      `changing ${field} must change the fetch cache key`,
    );
  }
});

test('cache: bytes are measured in UTF-8 bytes, not UTF-16 code units', () => {
  const cache = new ResultCache();
  const cjk = '中'.repeat(1000); // 1000 chars, 3000 UTF-8 bytes
  cache.set('k', cjk, {}, 0);
  assert.ok(cache.bytes >= 3000, `expected >=3000 bytes, got ${cache.bytes}`);
  assert.ok(cache.bytes > cjk.length, 'UTF-8 bytes must exceed code-unit length for CJK');
});
