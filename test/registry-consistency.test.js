import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SEARCH_BACKENDS, SEARCH_BACKEND_IDS } from '../lib/search-backends.js';
import { FETCH_BACKENDS, FETCH_BACKEND_IDS } from '../lib/fetch-backends.js';
import { DEFAULT_PROVIDER_ORDER } from '../lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

// The client bundle can't import the registries (it only loads seed modules), so its
// SEARCH_PROVIDERS table is a hand-maintained mirror. Parse it and guard the duplication.
const clientProviders = [...clientSource.matchAll(
  /\{ id: '([^']+)', titleKey: '[^']+', field: '[^']+', base: '[^']+', timeoutField: '([^']+)', defaultTimeoutMs: ([\d_]+), caps: \{[^}]*\} \}/g,
)].map((match) => ({
  id: match[1],
  timeoutField: match[2],
  defaultTimeoutMs: Number(match[3].replace(/_/g, '')),
}));

test('registry: default provider order only names known search backends', () => {
  assert.ok(DEFAULT_PROVIDER_ORDER.length > 0);
  for (const id of DEFAULT_PROVIDER_ORDER) {
    assert.ok(Object.hasOwn(SEARCH_BACKENDS, id), `unknown search backend in order: ${id}`);
  }
});

test('registry: every providerOrder id also has a fetch adapter', () => {
  // Fetch shares providerOrder, so each keyed vendor must exist in both registries.
  for (const id of DEFAULT_PROVIDER_ORDER) {
    assert.ok(Object.hasOwn(FETCH_BACKENDS, id), `missing fetch adapter for ${id}`);
  }
});

test('registry: keyed backends declare their config field names', () => {
  for (const backend of Object.values(SEARCH_BACKENDS)) {
    if (backend.keyRefsField === null) {
      assert.equal(backend.timeoutField, null, 'keyless search backend owns no timeout field');
      continue;
    }
    assert.equal(typeof backend.keyRefsField, 'string');
    assert.equal(typeof backend.timeoutField, 'string');
    assert.equal(typeof backend.defaultTimeoutMs, 'number');
    assert.equal(typeof backend.maxResults, 'number');
  }
  for (const backend of Object.values(FETCH_BACKENDS)) {
    if (backend.keyRefsField === null) continue;
    assert.equal(typeof backend.keyRefsField, 'string');
    assert.equal(typeof backend.timeoutField, 'string');
    assert.equal(typeof backend.defaultTimeoutMs, 'number');
  }
});

test('registry: client SEARCH_PROVIDERS mirror the search registry', () => {
  assert.ok(clientProviders.length > 0, 'failed to parse SEARCH_PROVIDERS from client.js');
  assert.deepEqual(clientProviders.map((p) => p.id), [...DEFAULT_PROVIDER_ORDER]);
  for (const entry of clientProviders) {
    const backend = SEARCH_BACKENDS[entry.id];
    assert.ok(backend, `client lists unknown provider ${entry.id}`);
    assert.equal(entry.timeoutField, backend.timeoutField, `timeoutField mismatch for ${entry.id}`);
    assert.equal(entry.defaultTimeoutMs, backend.defaultTimeoutMs, `defaultTimeoutMs mismatch for ${entry.id}`);
  }
});

test('registry: provider ids are consistent across both id maps', () => {
  for (const id of DEFAULT_PROVIDER_ORDER) {
    assert.ok(Object.values(SEARCH_BACKEND_IDS).includes(id), `not a search backend id: ${id}`);
    assert.ok(Object.values(FETCH_BACKEND_IDS).includes(id), `not a fetch backend id: ${id}`);
  }
});
