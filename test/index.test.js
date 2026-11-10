import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, PROVIDER_ID } from '../index.js';
import { Config } from '../lib/config.js';

/**
 * 造一个假 `ctx.web`，记录两个 provider 的注册与注销。
 * @param options - `{failFetch}`：为真时 `registerFetchProvider` 抛错，模拟宿主没有抓取 seam。
 * @returns 假 web 服务，带 `state`。
 */
function fakeWeb({ failFetch = false } = {}) {
  const state = { searchProvider: undefined, fetchProvider: undefined };
  return {
    state,
    registerSearchProvider(provider) {
      state.searchProvider = provider;
      return () => {
        state.searchProvider = undefined;
      };
    },
    registerFetchProvider(provider) {
      if (failFetch) throw new Error('host has no fetch seam');
      state.fetchProvider = provider;
      return () => {
        state.fetchProvider = undefined;
      };
    },
  };
}

/**
 * 造一个最小插件 ctx：只实现 `apply()` 真正触碰的 `web`、`logger`、`effect`、`get`。
 * @param options - `{web, credentials}`。
 * @returns 假插件 ctx，带 `effects` 与 `warnings` 便于断言。
 */
function fakePluginCtx({ web, credentials } = {}) {
  const effects = [];
  const warnings = [];
  return {
    web,
    effects,
    warnings,
    get(name) {
      if (name === 'credentials') return credentials;
      return undefined;
    },
    logger: { warn: (message) => warnings.push(message) },
    effect(fn, label) {
      effects.push({ fn, label });
      return () => {};
    },
  };
}

test('apply: registers both providers with the pinned id and available() always true', () => {
  const web = fakeWeb();
  const ctx = fakePluginCtx({ web });
  apply(ctx, Config({}));

  assert.ok(web.state.searchProvider, 'search provider must be registered');
  assert.equal(web.state.searchProvider.id, PROVIDER_ID);
  // 恒 true 是硬约束：被 pin 的 provider 自称不可用会硬抛，不回落。
  assert.equal(web.state.searchProvider.available(), true);

  assert.ok(web.state.fetchProvider, 'fetch provider must be registered');
  assert.equal(web.state.fetchProvider.id, PROVIDER_ID);
  assert.equal(web.state.fetchProvider.available(), true);
});

test('apply: a failing fetch registration does not stop the search provider', () => {
  const web = fakeWeb({ failFetch: true });
  const ctx = fakePluginCtx({ web });
  assert.doesNotThrow(() => apply(ctx, Config({})));

  // 搜索必须在先、且不受抓取注册失败影响：否则搜索会被 pin 后硬抛 MISSING。
  assert.ok(web.state.searchProvider, 'search provider must still be registered');
  assert.equal(web.state.fetchProvider, undefined);
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /fetch provider/);
});

test('apply: the search provider delegates into the router', async () => {
  const web = fakeWeb();
  const ctx = fakePluginCtx({ web, credentials: { async resolve() { return undefined; } } });
  // searchFallback 关掉、又没有任何 key ⇒ 链为空，router 直接抛，绝不发网络请求。
  apply(ctx, Config({ searchFallback: false }));
  await assert.rejects(
    () => web.state.searchProvider.search({ query: 'q' }, undefined),
    (error) => {
      assert.equal(error.code, 'WEB_SEARCH_ALL_PROVIDERS_FAILED');
      return true;
    },
  );
});

test('apply: the registered effect disposes both providers on teardown', () => {
  const web = fakeWeb();
  const ctx = fakePluginCtx({ web });
  apply(ctx, Config({}));

  assert.equal(ctx.effects.length, 1);
  const dispose = ctx.effects[0].fn();
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(web.state.searchProvider, undefined);
  assert.equal(web.state.fetchProvider, undefined);
});
