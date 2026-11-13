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

test('search registry: tavily and exa are keyed, official is keyless', () => {
  assert.equal(SEARCH_BACKENDS.tavily.keyRefsField, 'tavilyApiKeyRefs');
  assert.equal(SEARCH_BACKENDS.tavily.timeoutField, 'tavilyTimeoutMs');
  assert.equal(SEARCH_BACKENDS.exa.keyRefsField, 'exaApiKeyRefs');
  assert.equal(SEARCH_BACKENDS.exa.timeoutField, 'exaTimeoutMs');
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
  assert.equal(lookupSearchBackend('exa'), SEARCH_BACKENDS.exa);
  assert.equal(lookupSearchBackend('nope'), undefined);
});

test('search registry: the exa entry reads its search type from config, not a constant', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ results: [] });
  };
  try {
    const read = (key) => (key === 'exaSearchType' ? 'instant' : undefined);
    await SEARCH_BACKENDS.exa.run({
      apiKey: 'ek',
      request: { query: 'q' },
      signal: undefined,
      timeoutMs: 1_000,
      read,
    });
    assert.equal(bodies[0].type, 'instant');
  } finally {
    globalThis.fetch = original;
  }
});

test('search registry: the firecrawl entry passes query and maxResults through', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    return Response.json({ success: true, data: { web: [{ url: 'https://r.example', title: 'T' }] } });
  };
  try {
    const result = await SEARCH_BACKENDS.firecrawl.run({
      apiKey: 'fk',
      request: { query: 'router plugin', maxResults: 3 },
      signal: undefined,
      timeoutMs: 5_000,
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/v2\/search$/);
    assert.equal(seen[0].body.query, 'router plugin');
    assert.equal(seen[0].body.limit, 3);
    assert.equal(seen[0].auth, 'Bearer fk');
    assert.equal(result.sources[0].url, 'https://r.example');
  } finally {
    globalThis.fetch = original;
  }
});

test('search registry: the official entry is available only when its provider says so', () => {
  // 官方 provider 的可用性取决于有没有 key / 端点是否合法。这里只锁「异常绝不上抛」
  // 这条契约：拿一个连 ctx.get 都没有的假 ctx 去问，必须得到布尔值而不是抛错。
  const verdict = SEARCH_BACKENDS['deepseek-official'].isAvailable({});
  assert.equal(typeof verdict, 'boolean');
});

test('search registry: the official entry stays available even when ctx services explode', () => {
  const hostile = {
    get() {
      throw new Error('service exploded');
    },
  };
  // 官方 provider 的 available() 是「有 apiKey / 有 resolveApiKey / 有 account token」三者取或，
  // 而我们**总是**提供 resolveApiKey，所以它恒为 true——订阅账号不用填 key 也能走官方搜索。
  // 因此「官方兜底永远在链尾」是设计语义，不是漏判：真没配好时它会在 search() 里失败，
  // 错误汇总里多一条 `deepseek-official: ...`，比静默少一个后端更有信息量。
  // 这里同时锁住「读 settings/credentials 抛错也不上抛」——上抛会变成一次假的搜索失败。
  assert.equal(SEARCH_BACKENDS['deepseek-official'].isAvailable(hostile), true);
  assert.equal(SEARCH_BACKENDS['deepseek-official'].isAvailable({}), true);
});
