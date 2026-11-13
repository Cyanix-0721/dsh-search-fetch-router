import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEARCH_BACKENDS, SEARCH_BACKEND_IDS, lookupSearchBackend } from '../lib/search-backends.js';

test('search registry: every entry is well-formed', () => {
  for (const [id, backend] of Object.entries(SEARCH_BACKENDS)) {
    assert.equal(backend.id, id, `entry key ${id} must match its id`);
    assert.equal(typeof backend.label, 'string');
    assert.ok(
      backend.keyRefsField === null || typeof backend.keyRefsField === 'string',
      `${id}.keyRefsField must be string or null`,
    );
    assert.ok(
      backend.timeoutField === null || typeof backend.timeoutField === 'string',
      `${id}.timeoutField must be string or null`,
    );
    assert.equal(typeof backend.defaultTimeoutMs, 'number');
    assert.equal(typeof backend.run, 'function');
  }
});

test('search registry: tavily and brave are keyed, official is keyless', () => {
  assert.equal(SEARCH_BACKENDS.tavily.keyRefsField, 'tavilyApiKeyRefs');
  assert.equal(SEARCH_BACKENDS.tavily.timeoutField, 'tavilyTimeoutMs');
  assert.equal(SEARCH_BACKENDS.brave.keyRefsField, 'braveApiKeyRefs');
  assert.equal(SEARCH_BACKENDS.brave.timeoutField, 'braveTimeoutMs');
  assert.equal(SEARCH_BACKENDS['deepseek-official'].keyRefsField, null);
  assert.equal(typeof SEARCH_BACKENDS['deepseek-official'].isAvailable, 'function');
});

test('search registry: SEARCH_BACKEND_IDS covers every registry entry', () => {
  assert.deepEqual(
    Object.values(SEARCH_BACKEND_IDS).sort(),
    Object.keys(SEARCH_BACKENDS).sort(),
  );
});

test('search registry: lookup returns the entry, or undefined for unknown ids', () => {
  assert.equal(lookupSearchBackend('tavily'), SEARCH_BACKENDS.tavily);
  assert.equal(lookupSearchBackend('brave'), SEARCH_BACKENDS.brave);
  assert.equal(lookupSearchBackend('nope'), undefined);
});
