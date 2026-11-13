/**
 * Firecrawl REST：`/v2/scrape`。
 *
 * 与官方 `@firecrawl/dsh-firecrawl` 的实现对齐（请求体字段名、响应映射、
 * `metadata.statusCode` 回退规则），但**不复用它的包**——那个包的
 * peerDependencies 锁死在 DSH 0.1.0-rc.6，比当前宿主老两个 rc。
 *
 * @module dsh-search-fetch-router/firecrawl
 */

import { postJson, USER_AGENT } from './rest.js';

/** 默认端点。设置里不暴露，改端点没有正当用途。 */
export const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';

/** 文档规定 timeout 取值 1000..300000 毫秒，越界上游直接 400。 */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * 把段预算夹进 Firecrawl 接受的区间。
 *
 * 段预算可能只有几百毫秒（总预算快用完时），直接透传会换来一个 400——那看起来像
 * 「Firecrawl 挂了」，实际是我们自己发的非法请求。夹到下限至少能拿到一个真响应。
 * @param value - 期望的毫秒数。
 * @param fallback - 非有限数时用的值。
 * @returns 夹取后的毫秒数。
 */
function clampTimeout(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * 发一个 JSON POST 到 Firecrawl 的某个路径。
 *
 * 超时组合、非 2xx 错误体、`status` / `Retry-After` 挂载都在 `lib/rest.js`——三家共用一份。
 * @param path - 相对路径，如 `/v2/scrape`。
 * @param apiKey - 明文 key。
 * @param body - 请求体。
 * @param options - `{signal, timeoutMs, label}`；`label` 决定报错文案前缀。
 * @returns 解析后的 JSON。
 */
function postFirecrawl(path, apiKey, body, { signal, timeoutMs, label }) {
  return postJson({
    url: `${FIRECRAWL_BASE_URL}${path}`,
    label,
    headers: { 'user-agent': USER_AGENT, authorization: `Bearer ${apiKey}` },
    body,
    signal,
    timeoutMs,
  });
}

/**
 * 构造 `/v2/scrape` 的请求体。
 * @param url - 目标 URL。
 * @param options - `{onlyMainContent, maxAgeMs, timeoutMs}`。
 * @returns 请求体。
 */
export function buildScrapeBody(url, { onlyMainContent, maxAgeMs, timeoutMs }) {
  const timeout = clampTimeout(timeoutMs, 60_000);
  return {
    url,
    formats: ['markdown'],
    onlyMainContent,
    maxAge: maxAgeMs,
    timeout,
  };
}

/**
 * 把 `/v2/scrape` 的响应映射成 seam 的 `WebFetchResult` 形状。
 *
 * 200 但响应体里没有 `data` 时**不抛错**，而是返回 `{result: undefined, failure}`：
 * 这是请求级的上游异常（反爬拦截、上游软错误），不是「这把 key 坏了」。抛错会被执行层
 * 的 keyed catch 当成 key 级失败，把整个池的 key 一起打进冷却——一次软错误就让该供应商
 * 停摆一个冷却周期。调用方据 `result === undefined` 走 unusable 分支。
 *
 * @param payload - 已解析的 JSON。
 * @param requestedUrl - 请求时用的 URL，作为 `url` 的兜底。
 * @param options - `{maxBodyChars}`。
 * @returns `{url, statusCode, body, truncated, failure}`，或缺 `data` 时的 `{missing: true, failure}`。
 */
export function mapScrapeResponse(payload, requestedUrl, { maxBodyChars }) {
  const data = payload?.data;
  if (data === null || typeof data !== 'object') {
    const upstream = [payload?.error, payload?.message, payload?.details].find(
      (value) => typeof value === 'string' && value.trim().length > 0,
    );
    const why = upstream === undefined ? 'response.data is missing' : upstream.trim();
    return { missing: true, failure: `Firecrawl returned no page data: ${why}` };
  }
  const raw = typeof data.markdown === 'string' ? data.markdown : '';
  const truncated = raw.length > maxBodyChars;
  const content = truncated ? raw.slice(0, maxBodyChars) : raw;

  const metadata = data.metadata !== null && typeof data.metadata === 'object' ? data.metadata : {};
  const statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200;
  const candidate = [metadata.url, metadata.sourceURL].find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  // 抓取失败时 Firecrawl 仍可能给 200，把原因放在 metadata.error（或顶层 warning）里。
  // 不读它的话，「页面确实是空的」和「抓取被拦/超时」都只剩一句 empty body。
  const failure = [metadata.error, data.warning].find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  return {
    url: candidate ?? requestedUrl,
    statusCode,
    body: { kind: 'text', content },
    truncated,
    failure: failure === undefined ? undefined : failure.trim(),
  };
}

/**
 * 调 `/v2/scrape`。
 * @param options - `{apiKey, url, onlyMainContent, maxAgeMs, timeoutMs, maxBodyChars, signal}`。
 * @returns `{result, empty, failure}`：`result` 是映射后的抓取结果（缺 `data` 时为
 *   `undefined`），`empty` 表示正文为空，`failure` 是上游给的失败原因。
 */
export async function scrapeFirecrawl({
  apiKey,
  url,
  onlyMainContent,
  maxAgeMs,
  timeoutMs,
  maxBodyChars,
  signal,
}) {
  const payload = await postFirecrawl(
    '/v2/scrape',
    apiKey,
    buildScrapeBody(url, { onlyMainContent, maxAgeMs, timeoutMs }),
    { signal, timeoutMs, label: 'Firecrawl scrape' },
  );
  const mapped = mapScrapeResponse(payload, url, { maxBodyChars });
  // `data` 缺失：交给调用方当 unusable 处理，而不是抛错让整池 key 冷却。
  if (mapped.missing === true) return { result: undefined, empty: true, failure: mapped.failure };
  return { result: mapped, empty: mapped.body.content.trim().length === 0, failure: mapped.failure };
}

/**
 * 调 `/v2/search`（网页搜索）。
 *
 * 文档（POST /v2/search）：body `{ query, limit }`（limit 1..100，默认 10）。
 * 响应 `{ success, data: { web: [{ title, description, url, markdown, ... }] } }`。
 * @param options - `{apiKey, query, maxResults, signal, timeoutMs}`。
 * @returns `{sources, truncated}`，即 seam 的 `WebSearchResult`。
 */
export async function searchFirecrawl({ apiKey, query, maxResults, signal, timeoutMs }) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
  const limit = Number.isInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, 100) : 10;

  // `timeout` 是文档支持的服务端超时（毫秒）：本地的 AbortSignal 只能保护我们自己，
  // 服务端如果卡在爬取上，带这个参数能让它自己早退，而不是等我们断连。
  const payload = await postFirecrawl('/v2/search', apiKey, {
    query: typeof query === 'string' ? query : String(query ?? ''),
    limit,
    timeout: clampTimeout(ms, 30_000),
  }, { signal, timeoutMs: ms, label: 'Firecrawl search' });

  // 正常响应是 `{data:{web:[...]}}`；文档里也出现过 `data` 直接是数组的形态（老版本 /
  // 部分 SDK 示例），两种都认，避免一次 API 形状变化就把整条搜索链打空。
  const raw = payload?.data;
  const web = Array.isArray(raw?.web) ? raw.web : (Array.isArray(raw) ? raw : []);
  const sources = web.flatMap((item) => {
    if (item === null || typeof item !== 'object' || typeof item.url !== 'string') return [];
    const source = { url: item.url };
    if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title;
    // 默认响应带的是 highlights（query 相关的片段），不是 description；后者只在
    // highlights:false 时才有。优先取更贴题的 highlights，再退到 description / markdown。
    const highlight = Array.isArray(item.highlights)
      ? item.highlights.find((text) => typeof text === 'string' && text.length > 0)
      : undefined;
    const snippet = highlight
      ?? (typeof item.description === 'string' && item.description.length > 0
        ? item.description
        : (typeof item.markdown === 'string' ? item.markdown.slice(0, 500) : ''));
    if (snippet.length > 0) source.snippet = snippet;
    return [source];
  });
  return { sources, truncated: false };
}
