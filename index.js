/**
 * dsh-search-fetch-router —— Tavily 优先的 web 搜索与抓取路由器。
 *
 * 本文件是 harness 加载的插件入口。它只做三件事：
 *
 * 1. 注册搜索提供方，且放在**最前**，先于任何可能失败的步骤；
 * 2. 在 `try`/`catch` 内注册抓取提供方（可选能力，失败只 warn）；
 * 3. 把真正的决策交给 `lib/`，每次调用读一次当前配置，于是设置变更无需重新注册。
 *
 * 最要紧的细节是 `available()`。`cordis.patch.yml` 把 `searchProvider` 与
 * `fetchProvider` 静态 pin 到本插件的 id，一个自称不可用的提供方会导致硬抛
 * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，而不是回落。因此 `available()` 恒
 * `true`，所有真实判断活在 `search()` / `fetch()` 里，失败一律**降级**而不是抛。
 *
 * @module dsh-search-fetch-router
 */

import z from '@deepseek-ai/schemastery';

import { Config } from './lib/config.js';
import { createRouter } from './lib/execute.js';

export const name = 'dsh-search-fetch-router';
export const inject = ['web'];
export { Config };

/**
 * 插件 id，与 `cordis.patch.yml` 里 pin 的值、以及两个 provider 的 `id` 共用。
 * seam 把 search 与 fetch 存在两张表里，同名不冲突。
 */
export const PROVIDER_ID = 'search-fetch-router';

/**
 * 装配入口。
 * @param ctx - 插件上下文。
 * @param config - 本插件配置（`lib/config.js` 的 schema 解析结果）。
 */
export function apply(ctx, config = Config({})) {
  const router = createRouter(ctx, config);

  // 刻意作为第一条效果语句：patch 静态 pin 了 searchProvider，加载了却没注册
  // 会让每次搜索硬抛 WEB_PROVIDER_CONFIGURED_MISSING。上面的 `createRouter`
  // 与字面量构造都不会失败，一切可能失败的事都在下面。
  const unregisterSearch = ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    search: (request, signal) => router.search(request, signal),
  });

  // 抓取提供方同理，但**包在 try 里**：`web.registerFetchProvider` 是可选能力。
  // 宿主少了它只该让 web_fetch 走官方提供方，不该连搜索一起拖下水。
  let unregisterFetch;
  try {
    unregisterFetch = ctx.web.registerFetchProvider({
      id: PROVIDER_ID,
      available: () => true,
      fetch: (request, signal) => router.fetch(request, signal),
    });
  } catch (error) {
    ctx.logger?.warn?.(
      'dsh-search-fetch-router: could not register the fetch provider, so web_fetch keeps '
        + `using the host's own provider; search is unaffected: ${String(error)}`,
    );
  }

  // 宿主关闭时撤销注册。两个 provider 都显式注销：`registerProvider` 自己也会随
  // fiber 释放，但把 fetch 的句柄留住、一并撤销，卸载路径才在两边都成立。
  ctx.effect(() => () => {
    unregisterSearch();
    unregisterFetch?.();
  }, 'dsh-search-fetch-router.unregister()');
}
