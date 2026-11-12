/**
 * 纯决策层：给定「有哪些能力可用」，算出要按什么顺序试。
 *
 * 这一层不做任何 I/O，因此可以完整测试。真正的执行在 `lib/execute.js`。
 *
 * @module dsh-search-fetch-router/router
 */

/** 抓取提供方标识。tavily/firecrawl 是本插件直接调 REST；http 是宿主自带的。 */
export const FETCH_BACKENDS = Object.freeze({
  firecrawl: 'firecrawl',
  tavily: 'tavily',
  http: 'http',
});

/**
 * 搜索链：按用户配置的供应商顺序排，官方后端作为可选兜底追加在末尾。
 *
 * 这是**纯函数**——执行层负责把每个 id 映射成「有没有可用 key / 宿主能力在不在」，
 * 这里只做顺序、去重与兜底的决策。供应商从两个扩到 N 个，这个函数一行都不用改。
 *
 * 规则：
 * - 按 `order` 顺序遍历，跳过不存在的、重复的、以及不可用的（`isAvailable` 为假）；
 * - `order` 里若出现 `fallbackBackend` 本身，忽略它——兜底统一在末尾按 `fallback` 决定，
 *   避免同一个后端在链里出现两次；
 * - `fallback` 为真且官方兜底可用时，追加在末尾。
 *
 * @param options - 配置对象。
 * @param options.order - 启用的供应商 id，按尝试顺序。可含 `fallbackBackend`，会被忽略。
 * @param options.isAvailable - `(id) => boolean`，判断某个 id 当下是否可用。
 * @param options.fallback - 是否追加官方兜底。
 * @param options.fallbackBackend - 官方兜底的 id，默认 `'deepseek-official'`。
 * @returns 后端 id 数组，可能为空。
 */
export function planSearchChain({
  order = [],
  isAvailable = () => false,
  fallback = true,
  fallbackBackend = 'deepseek-official',
} = {}) {
  const chain = [];
  const seen = new Set();
  for (const id of order) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (id === fallbackBackend) continue;
    if (seen.has(id)) continue;
    if (isAvailable(id)) {
      chain.push(id);
      seen.add(id);
    }
  }
  if (fallback && !seen.has(fallbackBackend) && isAvailable(fallbackBackend)) {
    chain.push(fallbackBackend);
    seen.add(fallbackBackend);
  }
  return chain;
}

/**
 * 抓取链。固定顺序：Tavily → Firecrawl → 本地 http。
 *
 * 不再按 URL 定制提前——插件只做基础替换，多页 / 反爬 / 结构化这些高级抓取
 * 交给 firecrawl MCP。顺序固定，行为可预测、好排查。
 * @param options - `{hasFirecrawl, hasTavily, hasHttp, fallback}`。
 * @returns 后端名数组，可能为空。
 */
export function planFetchChain({ hasFirecrawl, hasTavily, hasHttp, fallback = true }) {
  const chain = [];
  const push = (backend, enabled) => {
    if (enabled && !chain.includes(backend)) chain.push(backend);
  };

  push(FETCH_BACKENDS.tavily, hasTavily);
  push(FETCH_BACKENDS.firecrawl, hasFirecrawl);
  push(FETCH_BACKENDS.http, fallback && hasHttp);
  return chain;
}

/**
 * Tavily 抽完之后要不要升级到 Firecrawl。
 *
 * 只认三种硬信号，不做「内容疑似不完整」的猜测：
 * - 抛错（网络失败、超时、非 2xx）；
 * - `failed_results[]` 非空（官方文档明确：全部 URL 抽取失败时 HTTP 仍是 200，`results` 为空）；
 * - 正文为空，或短于 `minContentChars`。
 * @param extract - `{content, failed}`，或 `undefined` 表示抛错。
 * @param minContentChars - 长度下限，0 表示只判空。
 * @returns 是否升级。
 */
export function shouldEscalate(extract, minContentChars = 0) {
  if (extract === undefined) return true;
  if (Array.isArray(extract.failed) && extract.failed.length > 0) return true;
  const content = typeof extract.content === 'string' ? extract.content.trim() : '';
  const floor = Math.max(0, Number.isFinite(minContentChars) ? minContentChars : 0);
  if (content.length === 0) return true;
  return floor > 0 && content.length <= floor;
}

/**
 * 从总预算里切出下一段的超时。
 * @param options - `remainingMs, segmentMs, minSegmentMs}`。
 * @returns 本段可用毫秒；`null` 表示预算已不够开新段。
 */
export function segmentTimeout({ remainingMs, segmentMs, minSegmentMs }) {
  if (!Number.isFinite(remainingMs) || remainingMs < minSegmentMs) return null;
  return Math.min(segmentMs, remainingMs);
}
