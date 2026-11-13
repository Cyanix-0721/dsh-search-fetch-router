/**
 * 声明式搜索后端注册表。
 *
 * **加一个搜索供应商要动三处，且「执行层」一行都不用改：**
 * 1. 在 {@link SEARCH_BACKENDS} 里加一项：`id` / `label` / `keyRefsField` / `timeoutField`
 *    / `defaultTimeoutMs` / `run`（有 key 池的还要 `isAvailable` 视情况）；
 * 2. 在 `lib/config.js` 加它的 key refs 数组字段与单次超时字段（都是 `.volatile()`）；
 * 3. 让用户把它的 `id` 填进设置里的 `providerOrder`。
 *
 * 执行层（`lib/execute.js`）只按这个注册表遍历：有 key 池的后端自动获得「轮转、冷却、
 * 失效跳过」，无 key 的后端（宿主自带能力）只看 `isAvailable(ctx)`。因此新增供应商
 * 不会引入新的 `if (backend === ...)` 分支——这正是这层抽象存在的理由。
 *
 * @module dsh-search-fetch-router/search-backends
 */

import { searchExa } from './exa.js';
import { searchFirecrawl } from './firecrawl.js';
import { createOfficialSearchProvider } from './official.js';
import { searchTavily } from './tavily.js';

/**
 * 供应商 id 常量。
 *
 * 单独抽出来，是因为这些字符串散落在配置、注册表、错误文案里；集中一处能防拼错，
 * 也让「官方后端」这个身份在比较时有个唯一来源（`searchFallback` 的兜底就是它）。
 */
export const SEARCH_BACKEND_IDS = Object.freeze({
  tavily: 'tavily',
  exa: 'exa',
  firecrawl: 'firecrawl',
  official: 'deepseek-official',
});

/**
 * 一个搜索后端的统一形态。
 *
 * 两种：
 * - **keyed**（`keyRefsField !== null`）：本插件直接调该供应商的 REST，凭据从 refs 池解析，
 *   一把 key 失败自动换下一把（池的轮转/冷却由执行层负责，这里只关心单次调用）。
 * - **keyless**（`keyRefsField === null`）：宿主自带的搜索能力（官方 deepseek-official），
 *   没有 key 池，靠 `isAvailable(ctx)` 判断当下能不能用。
 *
 * `run` 统一签名，参数里给什么由执行层按 keyed/keyless 决定，后端不用关心自己被哪种
 * 方式驱动。
 *
 * @typedef {object} SearchBackend
 * @property {string} id - 供应商 id，等于 `providerOrder` 里的取值。
 * @property {string} label - 人类可读名，出现在错误汇总里。
 * @property {string|null} keyRefsField - `config` 里 key refs 数组字段名；keyless 为 `null`。
 * @property {string|null} timeoutField - `config` 里单次超时字段名；keyless 为 `null`。
 * @property {number} defaultTimeoutMs - 读不到配置时的兜底超时（keyless 可填 0）。
 * @property {(ctx: object) => boolean} [isAvailable] - 仅 keyless 需要：宿主能力是否可用。
 * @property {(args: object) => Promise<object>} run - 真正执行，返回 seam 的 `WebSearchResult`。
 */

/**
 * 内置搜索后端注册表。`Object.freeze` 冻结，避免运行期被意外改写。
 *
 * @type {Readonly<Record<string, SearchBackend>>}
 */
export const SEARCH_BACKENDS = Object.freeze({
  [SEARCH_BACKEND_IDS.tavily]: Object.freeze({
    id: SEARCH_BACKEND_IDS.tavily,
    label: 'Tavily',
    keyRefsField: 'tavilyApiKeyRefs',
    timeoutField: 'tavilyTimeoutMs',
    defaultTimeoutMs: 15_000,
    /**
     * @param args - `{apiKey, ctx, request, signal, timeoutMs}`（ctx 目前未用它，但保持与 keyless 同形）。
     * @returns `WebSearchResult`。
     */
    async run({ apiKey, request, signal, timeoutMs }) {
      return searchTavily({
        apiKey,
        query: request?.query,
        maxResults: request?.maxResults,
        signal,
        timeoutMs,
      });
    },
  }),

  [SEARCH_BACKEND_IDS.exa]: Object.freeze({
    id: SEARCH_BACKEND_IDS.exa,
    label: 'Exa',
    keyRefsField: 'exaApiKeyRefs',
    timeoutField: 'exaTimeoutMs',
    defaultTimeoutMs: 15_000,
    /**
     * @param args - `{apiKey, request, signal, timeoutMs}`。
     * @returns `WebSearchResult`。
     */
    async run({ apiKey, request, signal, timeoutMs }) {
      return searchExa({
        apiKey,
        query: request?.query,
        maxResults: request?.maxResults,
        signal,
        timeoutMs,
      });
    },
  }),

  [SEARCH_BACKEND_IDS.firecrawl]: Object.freeze({
    id: SEARCH_BACKEND_IDS.firecrawl,
    label: 'Firecrawl',
    keyRefsField: 'firecrawlApiKeyRefs',
    timeoutField: 'firecrawlTimeoutMs',
    defaultTimeoutMs: 30_000,
    /**
     * @param args - `{apiKey, request, signal, timeoutMs}`。
     * @returns `WebSearchResult`。
     */
    async run({ apiKey, request, signal, timeoutMs }) {
      return searchFirecrawl({
        apiKey,
        query: request?.query,
        maxResults: request?.maxResults,
        signal,
        timeoutMs,
      });
    },
  }),

  [SEARCH_BACKEND_IDS.official]: Object.freeze({
    id: SEARCH_BACKEND_IDS.official,
    label: 'deepseek-official',
    keyRefsField: null,
    timeoutField: null,
    defaultTimeoutMs: 0,
    /**
     * 官方 provider 是否可用。构造真实例再问它——构造本身不发网络。
     * 抛错一律当不可用，绝不把异常冒泡成「搜索失败」。
     * @param ctx - 插件上下文。
     * @returns 可用与否。
     */
    isAvailable(ctx) {
      try {
        return createOfficialSearchProvider(ctx).available() === true;
      } catch {
        return false;
      }
    },
    /**
     * @param args - `{ctx, request, signal}`。
     * @returns `WebSearchResult`。
     */
    async run({ ctx, request, signal }) {
      return createOfficialSearchProvider(ctx).search(request, signal);
    },
  }),
});

/**
 * 按 id 取后端。未知 id 返回 `undefined`——执行层应跳过，而不是崩掉整条链。
 * @param id - 供应商 id。
 * @returns {SearchBackend|undefined} 对应后端。
 */
export function lookupSearchBackend(id) {
  return SEARCH_BACKENDS[id];
}
