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

test('search registry: reading settings blowing up does not make the official entry unavailable', () => {
  const hostile = {
    get() {
      throw new Error('service exploded');
    },
  };
  // 官方 provider 的 available() 是「有 apiKey / 有 resolveApiKey / 有 account token」三者取或，
  // 而我们**总是**提供 resolveApiKey，所以没配置时它仍为 true——订阅账号不用填 key 也能走官方
  // 搜索，这是设计语义。读 settings/credentials 抛错也只该退回默认值，不该变成「不可用」：
  // 那会让官方兜底凭空消失，而用户其实什么都没配错。
  assert.equal(SEARCH_BACKENDS['deepseek-official'].isAvailable(hostile), true);
  assert.equal(SEARCH_BACKENDS['deepseek-official'].isAvailable({}), true);
});

test('search registry: an official endpoint that does not parse marks the entry unavailable', () => {
  // available() 除了凭据还要求 baseURL 能被解析、maxTokens/maxUses 是正整数。
  // 用户在设置里把端点写坏时，跳过官方兜底比拿一个非法 URL 去发请求好——
  // 后者会在 search() 里失败，白等一个段预算。
  const broken = {
    get(ns) {
      if (ns !== 'settings') return undefined;
      return {
        describe: () => [
          { ns: 'web-search-deepseek', value: { baseURL: 'not a url', maxTokens: 0 } },
        ],
      };
    },
  };
  assert.equal(SEARCH_BACKENDS['deepseek-official'].isAvailable(broken), false);
});

test('search registry: the tavily entry reads search depth and topic from config', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ results: [] });
  };
  try {
    const read = (key) => {
      if (key === 'tavilySearchDepth') return 'advanced';
      if (key === 'tavilyTopic') return 'news';
      return undefined;
    };
    await SEARCH_BACKENDS.tavily.run({
      apiKey: 'tk',
      request: { query: 'q' },
      signal: undefined,
      timeoutMs: 1_000,
      read,
    });
    assert.equal(bodies[0].search_depth, 'advanced');
    assert.equal(bodies[0].topic, 'news');
  } finally {
    globalThis.fetch = original;
  }
});
