/**
 * 声明式抓取后端注册表。
 *
 * **边界（务必守住）**：这里只做「单 URL 的基础抓取」——把 Tavily /extract、Firecrawl
 * 单页 scrape、本地 http 三种能力包成统一形状。整站爬、反爬、结构化抽取、批量任务这些
 * **高级能力属于 firecrawl MCP，不进本插件**。本插件是 `web_fetch` 的一条路由，不是爬虫。
 *
 * 与 `lib/search-backends.js` 对称：执行层只按注册表遍历，不再有 `if (backend === ...)`。
 * 加一个抓取供应商要动的地方里，执行层一行都不用改。
 *
 * @module dsh-search-fetch-router/fetch-backends
 */

import { contentsExa } from './exa.js';
import { createOfficialFetchProvider } from './official.js';
import { scrapeFirecrawl } from './firecrawl.js';
import { shouldEscalate } from './router.js';
import { extractTavily } from './tavily.js';

/** 抓取后端 id 常量。与 `lib/router.js` 的 `FETCH_BACKENDS` 取值保持一致（由测试守护）。 */
export const FETCH_BACKEND_IDS = Object.freeze({
  tavily: 'tavily',
  exa: 'exa',
  firecrawl: 'firecrawl',
  http: 'http',
});

/**
 * 组合「调用方信号 + 本段超时」。仅 keyless 的本地 http 用——Tavily / Firecrawl 的
 * REST 封装自己吃 `timeoutMs`，在内部组合。
 * @param signal - 调用方信号。
 * @param ms - 本段毫秒。
 * @returns 组合信号。
 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * 统一返回形状：
 * - `{kind:'result', result}`：拿到可用结果，执行层直接返回；
 * - `{kind:'unusable', reason}`：本后端**没给出可用内容**（如 Tavily 抽出空/失败、
 *   Firecrawl 返回空正文）——执行层记一条失败、换下一个后端，**不惩罚 key**（key 本身没错）；
 * - 抛错：网络/HTTP/超时等真错误——执行层惩罚该 key、换下一把。
 *
 * `keepLastErrorOnUnusable`：某后端「先前某把 key 抛过错、随后又判定 unusable」时，是否
 * 要把那条抛错也一并上报。为保持与重构前逐字一致：Firecrawl 旧逻辑是无条件上报（true），
 * Tavily 旧逻辑在已升级时不上报（false）。
 *
 * `run` 的入参：`{apiKey, ctx, request, signal, budgetMs, read, maxBodyChars}`
 * （keyless 后端不给 apiKey；`read(key)` 读当前配置字段）。
 *
 * @typedef {object} FetchBackend
 * @property {string} id
 * @property {string} label
 * @property {string|null} keyRefsField - keyless 为 null。
 * @property {string} timeoutField - config 里的单段超时字段名。
 * @property {number} defaultTimeoutMs
 * @property {boolean} [keepLastErrorOnUnusable]
 * @property {(args: object) => Promise<object>} run
 */

/** 内置抓取后端注册表。`Object.freeze` 冻结，避免运行期被意外改写。 */
export const FETCH_BACKENDS = Object.freeze({
  [FETCH_BACKEND_IDS.tavily]: Object.freeze({
    id: FETCH_BACKEND_IDS.tavily,
    label: 'Tavily',
    keyRefsField: 'tavilyApiKeyRefs',
    timeoutField: 'tavilyTimeoutMs',
    defaultTimeoutMs: 15_000,
    keepLastErrorOnUnusable: false,
    async run({ apiKey, request, signal, budgetMs, read, maxBodyChars }) {
      const extract = await extractTavily({
        apiKey,
        url: request.url,
        depth: read('tavilyExtractDepth') === 'advanced' ? 'advanced' : 'basic',
        signal,
        timeoutMs: budgetMs,
      });
      const configured = read('minContentChars');
      const floor = Number.isFinite(configured) && configured > 0 ? configured : 0;
      if (shouldEscalate(extract, floor)) {
        const why = Array.isArray(extract.failed) && extract.failed.length > 0
          ? 'failed_results non-empty'
          : 'content too short';
        return { kind: 'unusable', reason: `extracted content is unusable (${why})` };
      }
      const truncated = extract.content.length > maxBodyChars;
      return {
        kind: 'result',
        result: {
          url: request.url,
          statusCode: 200,
          body: {
            kind: 'text',
            content: truncated ? extract.content.slice(0, maxBodyChars) : extract.content,
          },
          truncated,
        },
      };
    },
  }),

  [FETCH_BACKEND_IDS.firecrawl]: Object.freeze({
    id: FETCH_BACKEND_IDS.firecrawl,
    label: 'Firecrawl',
    keyRefsField: 'firecrawlApiKeyRefs',
    timeoutField: 'firecrawlTimeoutMs',
    defaultTimeoutMs: 30_000,
    keepLastErrorOnUnusable: true,
    async run({ apiKey, request, signal, budgetMs, read, maxBodyChars }) {
      const configuredMaxAge = read('firecrawlMaxAgeMs');
      const { result, empty, failure } = await scrapeFirecrawl({
        apiKey,
        url: request.url,
        onlyMainContent: read('firecrawlOnlyMainContent') !== false,
        maxAgeMs: Number.isFinite(configuredMaxAge) ? configuredMaxAge : 172_800_000,
        timeoutMs: budgetMs,
        maxBodyChars,
        signal,
      });
      if (empty) {
        // 上游可能 200 但把失败原因写在 metadata.error / warning 里；带上它才能区分
        // 「页面确实空」和「被反爬拦下 / 超时」。
        const why = typeof failure === 'string' && failure.length > 0 ? `: ${failure}` : '';
        return { kind: 'unusable', reason: `Firecrawl returned an empty body${why}` };
      }
      return { kind: 'result', result };
    },
  }),

  [FETCH_BACKEND_IDS.exa]: Object.freeze({
    id: FETCH_BACKEND_IDS.exa,
    label: 'Exa',
    keyRefsField: 'exaApiKeyRefs',
    timeoutField: 'exaTimeoutMs',
    defaultTimeoutMs: 15_000,
    keepLastErrorOnUnusable: false,
    async run({ apiKey, request, signal, budgetMs, maxBodyChars }) {
      const { content, failure } = await contentsExa({
        apiKey,
        url: request.url,
        signal,
        timeoutMs: budgetMs,
        maxBodyChars,
      });
      if (typeof content !== 'string' || content.trim().length === 0) {
        // 上游可能整体 200、只把这个 URL 标成失败并给出原因；把它带出来，
        // 否则「抓不到」和「页面是空的」在报错里长得一样，没法排查。
        const why = typeof failure === 'string' && failure.length > 0 ? `: ${failure}` : '';
        return { kind: 'unusable', reason: `Exa returned an empty body${why}` };
      }
      const truncated = content.length > maxBodyChars;
      return {
        kind: 'result',
        result: {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text', content: truncated ? content.slice(0, maxBodyChars) : content },
          truncated,
        },
      };
    },
  }),

  [FETCH_BACKEND_IDS.http]: Object.freeze({
    id: FETCH_BACKEND_IDS.http,
    label: 'local HTTP',
    keyRefsField: null,
    timeoutField: 'httpTimeoutMs',
    defaultTimeoutMs: 10_000,
    keepLastErrorOnUnusable: false,
    async run({ ctx, request, signal, budgetMs }) {
      const provider = createOfficialFetchProvider();
      const result = await provider.fetch(request, withTimeout(signal, budgetMs));
      return { kind: 'result', result };
    },
  }),
});

/**
 * 按 id 取抓取后端。未知 id 返回 `undefined`——执行层应跳过，而不是崩掉整条链。
 * @param id - 供应商 id。
 * @returns {FetchBackend|undefined} 对应后端。
 */
export function lookupFetchBackend(id) {
  return FETCH_BACKENDS[id];
}
