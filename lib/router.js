/**
 * 纯决策层：给定「有哪些能力可用」，算出要按什么顺序试。
 *
 * 这一层不做任何 I/O，因此可以完整测试。真正的执行在 `lib/execute.js`。
 *
 * @module dsh-search-fetch-router/router
 */

/** 提供方标识。Tavily 与 Firecrawl 是本插件直接调 REST；official/http 是宿主自带的。 */
export const SEARCH_BACKENDS = Object.freeze({
  tavily: 'tavily',
  official: 'deepseek-official',
});

export const FETCH_BACKENDS = Object.freeze({
  firecrawl: 'firecrawl',
  tavily: 'tavily',
  http: 'http',
});

/**
 * 搜索链：Tavily 池 → 官方。
 * @param options - `{hasTavily, hasOfficial, fallback}`。
 * @returns 后端名数组，可能为空。
 */
export function planSearchChain({ hasTavily, hasOfficial, fallback = true }) {
  const chain = [];
  if (hasTavily) chain.push(SEARCH_BACKENDS.tavily);
  if (fallback && hasOfficial) chain.push(SEARCH_BACKENDS.official);
  return chain;
}

/**
 * 抓取链。白名单命中时 Firecrawl 提前到第一位——用户已经点名要它，不必先花一次
 * Tavily 调用再升级。
 * @param options - `{url, patterns, hasFirecrawl, hasTavily, hasHttp, fallback, matches}`。
 * @returns 后端名数组，可能为空。
 */
export function planFetchChain({ url, patterns, hasFirecrawl, hasTavily, hasHttp, fallback = true, matches }) {
  const whitelisted = typeof matches === 'function' ? matches(url, patterns) : false;
  const chain = [];
  const push = (backend, enabled) => {
    if (enabled && !chain.includes(backend)) chain.push(backend);
  };

  if (whitelisted) {
    push(FETCH_BACKENDS.firecrawl, hasFirecrawl);
    push(FETCH_BACKENDS.tavily, hasTavily);
  } else {
    push(FETCH_BACKENDS.tavily, hasTavily);
    push(FETCH_BACKENDS.firecrawl, hasFirecrawl);
  }
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
