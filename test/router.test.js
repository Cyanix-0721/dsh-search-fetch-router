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

test('fetch chain: fixed order Tavily, Firecrawl, http', () => {
  assert.deepEqual(
    planFetchChain({ hasFirecrawl: true, hasTavily: true, hasHttp: true, fallback: true }),
    ['tavily', 'firecrawl', 'http'],
  );
});

test('fetch chain: no backend is listed twice', () => {
  const chain = planFetchChain({ hasFirecrawl: true, hasTavily: true, hasHttp: true, fallback: true });
  assert.equal(new Set(chain).size, chain.length);
});

test('fetch chain: no Firecrawl key drops it from the chain', () => {
  assert.deepEqual(
    planFetchChain({ hasFirecrawl: false, hasTavily: true, hasHttp: true, fallback: true }),
    ['tavily', 'http'],
  );
});

test('fetch chain: fallback disabled removes the local http provider', () => {
  assert.deepEqual(
    planFetchChain({ hasFirecrawl: false, hasTavily: true, hasHttp: true, fallback: false }),
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
