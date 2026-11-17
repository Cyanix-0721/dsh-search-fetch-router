import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBundle } from './helpers/client-harness.js';

function buildDiagnostics() {
  const { captured, require } = loadBundle();
  return captured.factory(require).__test.buildDiagnostics;
}

test('diagnostics: orders the chain, flags unknown ids, missing keys and disabled providers', () => {
  const build = buildDiagnostics();
  const diag = build({
    order: ['tavily', 'exa', 'gone'],
    enabled: true,
    providers: [
      { id: 'tavily', label: 'Tavily', configured: true, timeoutMs: 9000, defaultTimeoutMs: 15000 },
      { id: 'exa', label: 'Exa', configured: false, timeoutMs: undefined, defaultTimeoutMs: 15000 },
      { id: 'firecrawl', label: 'Firecrawl', configured: true, timeoutMs: 30000, defaultTimeoutMs: 30000 },
    ],
    cache: { enabled: true, ttlMs: 300000, maxEntries: 100, maxBytes: 8000000, generation: 2 },
  });
  assert.equal(diag.enabled, true);
  assert.deepEqual(diag.chain.map((c) => c.id), ['tavily', 'exa', 'gone']);
  assert.equal(diag.chain[0].known, true);
  assert.equal(diag.chain[1].configured, false);
  assert.equal(diag.chain[2].known, false);
  // firecrawl is configured but absent from providerOrder → shown as disabled.
  assert.deepEqual(diag.disabled, [{ id: 'firecrawl', label: 'Firecrawl' }]);
  const codes = diag.warnings.map((w) => w.code);
  assert.ok(codes.includes('missing-key'), 'exa has no key → missing-key');
  assert.ok(codes.includes('unknown'), 'gone is unknown');
  assert.equal(diag.cache.on, true);
});

test('diagnostics: reports the master switch and cache-disabled states', () => {
  const build = buildDiagnostics();
  const off = build({ order: [], enabled: false, providers: [], cache: { enabled: false, maxEntries: 100 } });
  assert.equal(off.enabled, false);
  assert.equal(off.cache.on, false);
  assert.deepEqual(off.chain, []);

  const noEntries = build({ order: [], providers: [], cache: { enabled: true, maxEntries: 0 } });
  assert.ok(noEntries.warnings.some((w) => w.code === 'cache-no-entries'));
});

test('diagnostics: dedupes repeated order ids and ignores empty/invalid entries', () => {
  const build = buildDiagnostics();
  const diag = build({
    order: ['tavily', 'tavily', '', null, 'exa'],
    providers: [
      { id: 'tavily', label: 'Tavily', configured: true },
      { id: 'exa', label: 'Exa', configured: true },
    ],
    cache: { enabled: false },
  });
  assert.deepEqual(diag.chain.map((c) => c.id), ['tavily', 'exa']);
  assert.deepEqual(diag.disabled, []);
  assert.deepEqual(diag.warnings, []);
});
