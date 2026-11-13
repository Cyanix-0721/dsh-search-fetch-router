import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planFetchChain, planSearchChain, segmentTimeout, shouldEscalate } from '../lib/router.js';

test('search chain: follows the configured order, official appended as fallback', () => {
  const available = new Set(['tavily', 'deepseek-official']);
  assert.deepEqual(
    planSearchChain({ order: ['tavily'], isAvailable: (id) => available.has(id), fallback: true }),
    ['tavily', 'deepseek-official'],
  );
});

test('search chain: fallback disabled drops the official provider', () => {
  const available = new Set(['tavily', 'deepseek-official']);
  assert.deepEqual(
    planSearchChain({ order: ['tavily'], isAvailable: (id) => available.has(id), fallback: false }),
    ['tavily'],
  );
});

test('search chain: an unavailable provider leaves only the official fallback', () => {
  const available = new Set(['deepseek-official']);
  assert.deepEqual(
    planSearchChain({ order: ['tavily'], isAvailable: (id) => available.has(id), fallback: true }),
    ['deepseek-official'],
  );
});

test('search chain: nothing usable yields an empty chain', () => {
  assert.deepEqual(
    planSearchChain({ order: ['tavily'], isAvailable: () => false, fallback: true }),
    [],
  );
});

test('search chain: many providers keep order, dedupe, one official fallback at the end', () => {
  const available = new Set(['tavily', 'exa', 'deepseek-official']);
  assert.deepEqual(
    planSearchChain({ order: ['exa', 'tavily', 'exa'], isAvailable: (id) => available.has(id), fallback: true }),
    ['exa', 'tavily', 'deepseek-official'],
  );
});

test('search chain: an id listed only as the fallback is not duplicated', () => {
  const available = new Set(['deepseek-official']);
  assert.deepEqual(
    planSearchChain({ order: ['deepseek-official'], isAvailable: (id) => available.has(id), fallback: true }),
    ['deepseek-official'],
  );
});

test('search chain: an unknown id in the order is skipped', () => {
  const available = new Set(['tavily', 'deepseek-official']);
  assert.deepEqual(
    planSearchChain({ order: ['nope', 'tavily'], isAvailable: (id) => available.has(id), fallback: true }),
    ['tavily', 'deepseek-official'],
  );
});

test('fetch chain: follows providerOrder, http appended as fallback', () => {
  const available = new Set(['tavily', 'exa', 'firecrawl', 'http']);
  assert.deepEqual(
    planFetchChain({ order: ['tavily', 'exa', 'firecrawl'], isAvailable: (id) => available.has(id), fallback: true }),
    ['tavily', 'exa', 'firecrawl', 'http'],
  );
});

test('fetch chain: no backend is listed twice', () => {
  const available = new Set(['tavily', 'exa', 'firecrawl', 'http']);
  const chain = planFetchChain({ order: ['tavily', 'exa', 'firecrawl'], isAvailable: (id) => available.has(id), fallback: true });
  assert.equal(new Set(chain).size, chain.length);
});

test('fetch chain: providers without keys are skipped, http still falls back', () => {
  const available = new Set(['tavily', 'http']); // exa/firecrawl have no key
  assert.deepEqual(
    planFetchChain({ order: ['tavily', 'exa', 'firecrawl'], isAvailable: (id) => available.has(id), fallback: true }),
    ['tavily', 'http'],
  );
});

test('fetch chain: fallback disabled removes the local http provider', () => {
  const available = new Set(['tavily', 'http']);
  assert.deepEqual(
    planFetchChain({ order: ['tavily'], isAvailable: (id) => available.has(id), fallback: false }),
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
