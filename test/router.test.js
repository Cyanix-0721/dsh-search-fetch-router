import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planFetchChain, planSearchChain, segmentTimeout, shouldEscalate } from '../lib/router.js';

test('search chain: Tavily first, official as fallback', () => {
  assert.deepEqual(
    planSearchChain({ hasTavily: true, hasOfficial: true, fallback: true }),
    ['tavily', 'deepseek-official'],
  );
});

test('search chain: fallback disabled drops the official provider', () => {
  assert.deepEqual(
    planSearchChain({ hasTavily: true, hasOfficial: true, fallback: false }),
    ['tavily'],
  );
});

test('search chain: no Tavily key reference leaves only the official provider', () => {
  assert.deepEqual(
    planSearchChain({ hasTavily: false, hasOfficial: true, fallback: true }),
    ['deepseek-official'],
  );
});

test('search chain: nothing usable yields an empty chain', () => {
  assert.deepEqual(planSearchChain({ hasTavily: false, hasOfficial: false, fallback: true }), []);
});

test('fetch chain: Tavily first, Firecrawl escalates, http last', () => {
  assert.deepEqual(
    planFetchChain({
      url: 'https://example.com/a',
      patterns: [],
      hasFirecrawl: true,
      hasTavily: true,
      hasHttp: true,
      fallback: true,
      matches: () => false,
    }),
    ['tavily', 'firecrawl', 'http'],
  );
});

test('fetch chain: a whitelisted URL goes straight to Firecrawl', () => {
  assert.deepEqual(
    planFetchChain({
      url: 'https://docs.example.com/guide',
      patterns: ['docs.example.com/**'],
      hasFirecrawl: true,
      hasTavily: true,
      hasHttp: true,
      fallback: true,
      matches: () => true,
    }),
    ['firecrawl', 'tavily', 'http'],
  );
});

test('fetch chain: no backend is listed twice', () => {
  const chain = planFetchChain({
    url: 'https://example.com',
    patterns: [],
    hasFirecrawl: true,
    hasTavily: true,
    hasHttp: true,
    fallback: true,
    matches: () => false,
  });
  assert.equal(new Set(chain).size, chain.length);
});

test('fetch chain: fallback disabled removes the local http provider', () => {
  assert.deepEqual(
    planFetchChain({
      url: 'https://example.com',
      patterns: [],
      hasFirecrawl: false,
      hasTavily: true,
      hasHttp: true,
      fallback: false,
      matches: () => false,
    }),
    ['tavily'],
  );
});

test('escalation: a thrown request always escalates', () => {
  assert.equal(shouldEscalate(undefined), true);
});

test('escalation: failed_results non-empty escalates even with content', () => {
  assert.equal(shouldEscalate({ content: 'plenty of text', failed: [{ url: 'https://x', error: 'blocked' }] }), true);
});

test('escalation: empty content escalates', () => {
  assert.equal(shouldEscalate({ content: '   ', failed: [] }), true);
});

test('escalation: content above the floor does not escalate', () => {
  assert.equal(shouldEscalate({ content: 'a'.repeat(200), failed: [] }), false);
});

test('escalation: content below a positive floor escalates', () => {
  assert.equal(shouldEscalate({ content: 'short', failed: [] }, 500), true);
});

test('escalation: floor 0 only judges emptiness, not length', () => {
  assert.equal(shouldEscalate({ content: 'x', failed: [] }, 0), false);
});

test('segment timeout is capped by the remaining budget', () => {
  assert.equal(segmentTimeout({ remainingMs: 30_000, segmentMs: 15_000, minSegmentMs: 2_000 }), 15_000);
  assert.equal(segmentTimeout({ remainingMs: 5_000, segmentMs: 15_000, minSegmentMs: 2_000 }), 5_000);
});

test('segment timeout refuses to start below the minimum', () => {
  assert.equal(segmentTimeout({ remainingMs: 1_000, segmentMs: 15_000, minSegmentMs: 2_000 }), null);
  assert.equal(segmentTimeout({ remainingMs: Number.NaN, segmentMs: 1, minSegmentMs: 2_000 }), null);
});
