import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FETCH_BACKENDS, FETCH_BACKEND_IDS, lookupFetchBackend } from '../lib/fetch-backends.js';
import { FETCH_BACKENDS as ROUTER_FETCH_BACKENDS } from '../lib/router.js';

test('fetch registry: keys match the router constants exactly', () => {
  // router 的 FETCH_BACKENDS 是给 planFetchChain 用的纯决策常量，注册表是执行侧的适配器。
  // 两边取值必须一一对应，否则 chain 里出现的 id 在注册表里找不到。
  assert.deepEqual(Object.keys(FETCH_BACKENDS).sort(), Object.values(ROUTER_FETCH_BACKENDS).sort());
});

test('fetch registry: every entry is well-formed', () => {
  for (const [key, backend] of Object.entries(FETCH_BACKENDS)) {
    assert.equal(backend.id, key, 'id must equal its registry key');
    assert.equal(typeof backend.label, 'string');
    assert.ok(
      backend.keyRefsField === null || typeof backend.keyRefsField === 'string',
      'keyRefsField is either null (keyless) or a config field name',
    );
    assert.equal(typeof backend.timeoutField, 'string');
    assert.equal(typeof backend.defaultTimeoutMs, 'number');
    assert.equal(typeof backend.run, 'function');
  }
});

test('fetch registry: tavily and firecrawl are keyed, http is keyless', () => {
  assert.equal(FETCH_BACKENDS[FETCH_BACKEND_IDS.tavily].keyRefsField, 'tavilyApiKeyRefs');
  assert.equal(FETCH_BACKENDS[FETCH_BACKEND_IDS.firecrawl].keyRefsField, 'firecrawlApiKeyRefs');
  assert.equal(FETCH_BACKENDS[FETCH_BACKEND_IDS.http].keyRefsField, null);
});

test('fetch registry: lookup returns the entry or undefined for unknown ids', () => {
  assert.equal(lookupFetchBackend('tavily'), FETCH_BACKENDS.tavily);
  assert.equal(lookupFetchBackend('nope'), undefined);
});
