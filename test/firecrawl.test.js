import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildScrapeBody, mapScrapeResponse } from '../lib/firecrawl.js';

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

test('map: missing data throws', () => {
  assert.throws(() => mapScrapeResponse({}, 'https://example.com', { maxBodyChars: 10 }), /response\.data is missing/);
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

test('map: a missing markdown field becomes an empty body', () => {
  const result = mapScrapeResponse({ data: { metadata: {} } }, 'https://example.com', { maxBodyChars: 10 });
  assert.equal(result.body.content, '');
});
