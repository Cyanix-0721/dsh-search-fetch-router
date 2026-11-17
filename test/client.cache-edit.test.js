import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadBundle, fakeContext, flatten } from './helpers/client-harness.js';

/** Mount the settings card with an injected config snapshot, return its rendered tree. */
function mountCard(configValue, options) {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations, state } = fakeContext(configValue, options);
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });
  const tree = element.type(element.props);
  return { tree, state, exported };
}

const CACHE_CONFIG = {
  tavilyApiKeyRefs: ['TAVILY_API_KEY'],
  firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
  cacheEnabled: true,
  cacheMaxEntries: 100,
  cacheMaxBytes: 8 * 1024 * 1024,
  cacheTtlMs: 300_000,
};

test('client: planCacheInputs converts MB to bytes and seconds to ms', () => {
  const { captured, require } = loadBundle();
  const { planCacheInputs } = captured.factory(require).__test;
  const plan = planCacheInputs({ maxEntries: '50', maxBytesMB: '4', ttlSec: '120' });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.ops, [
    { op: 'set', path: ['cacheMaxEntries'], value: 50 },
    { op: 'set', path: ['cacheMaxBytes'], value: 4 * 1024 * 1024 },
    { op: 'set', path: ['cacheTtlMs'], value: 120_000 },
  ]);
});

test('client: planCacheInputs treats ttl 0 as "use default" (0 ms passthrough)', () => {
  const { captured, require } = loadBundle();
  const { planCacheInputs } = captured.factory(require).__test;
  const plan = planCacheInputs({ maxEntries: '0', maxBytesMB: '0', ttlSec: '0' });
  assert.deepEqual(plan.ops, [
    { op: 'set', path: ['cacheMaxEntries'], value: 0 },
    { op: 'set', path: ['cacheMaxBytes'], value: 0 },
    { op: 'set', path: ['cacheTtlMs'], value: 0 },
  ]);
});

test('client: planCacheInputs rejects bad numbers with i18n keys', () => {
  const { captured, require } = loadBundle();
  const { planCacheInputs } = captured.factory(require).__test;
  assert.equal(planCacheInputs({ maxEntries: '-1', maxBytesMB: '4', ttlSec: '60' }).error, 'cacheInvalidEntries');
  assert.equal(planCacheInputs({ maxEntries: '1.5', maxBytesMB: '4', ttlSec: '60' }).error, 'cacheInvalidEntries');
  assert.equal(planCacheInputs({ maxEntries: '10', maxBytesMB: 'x', ttlSec: '60' }).error, 'cacheInvalidBytes');
  assert.equal(planCacheInputs({ maxEntries: '10', maxBytesMB: '4', ttlSec: '-5' }).error, 'cacheInvalidTtl');
});

test('client: the card exposes editable cache inputs and saves via mutate', async () => {
  const { tree, state } = mountCard(CACHE_CONFIG);
  const nodes = flatten(tree);
  const entries = nodes.find((n) => n.type === 'input' && n.props?.['data-sfr-cache-entries'] !== undefined);
  const bytes = nodes.find((n) => n.type === 'input' && n.props?.['data-sfr-cache-bytes'] !== undefined);
  const ttl = nodes.find((n) => n.type === 'input' && n.props?.['data-sfr-cache-ttl'] !== undefined);
  const save = nodes.find((n) => n.type === 'button' && n.props?.['data-sfr-cache-save'] !== undefined);
  const toggle = nodes.find((n) => n.type === 'button' && n.props?.['data-sfr-cache-toggle'] !== undefined);
  assert.ok(entries && bytes && ttl && save && toggle, 'cache controls should render');
  // Values shown in human units: entries as-is, bytes as MB, ttl as seconds.
  assert.equal(entries.props.value, '100');
  assert.equal(bytes.props.value, '8');
  assert.equal(ttl.props.value, '300');

  await save.props.onClick();
  const saved = state.mutations.at(-1);
  assert.deepEqual(saved, [
    { op: 'set', path: ['cacheMaxEntries'], value: 100 },
    { op: 'set', path: ['cacheMaxBytes'], value: 8 * 1024 * 1024 },
    { op: 'set', path: ['cacheTtlMs'], value: 300_000 },
  ]);

  await toggle.props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['cacheEnabled'], value: false },
  ]);
});
