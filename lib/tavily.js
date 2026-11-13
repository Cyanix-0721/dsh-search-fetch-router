/**
 * Tavily REST：`/search` 与 `/extract`。
 *
 * 认证用 `authorization: Bearer <key>`。两个端点都是 POST JSON。
 *
 * **`/extract` 的 200 不等于成功**：官方文档明确「HTTP 200 can have an empty
 * results array when all valid URLs fail during extraction」。所以成功判定必须
 * 看 `results[0].raw_content`，失败原因从 `failed_results[]` 里读。
 *
 * @module dsh-search-fetch-router/tavily
 */

import { errorPayload, postJson, requestFailure, USER_AGENT } from './rest.js';

/** 默认端点。设置里不暴露，改端点没有正当用途。 */
export const TAVILY_BASE_URL = 'https://api.tavily.com';

/** `/search` 的 `max_results` 上限，官方文档范围 0–20。 */
const MAX_RESULTS = 20;

/**
 * 规整 `/extract` 的抽取深度。
 *
 * 官方只认 `basic` / `advanced`。配置里那个字段是 `z.string()`（枚举会在 schema 校验阶段
 * 抛错，而 Config 抛错会让整个插件加载失败），所以规整放在这里：trim 后正好是 `advanced`
 * 才用它，其余（拼错、大小写不符、空串、非字符串）一律 `basic`——坏值最多损失一点正文
 * 完整度，绝不会把非法值发给上游（上游对未知 depth 返回 400，整次抓取就白费了）。
 * @param value - 配置里读到的任意值。
 * @returns `'basic'` 或 `'advanced'`。
 */
export function normalizeExtractDepth(value) {
  if (typeof value !== 'string') return 'basic';
  // 大小写不敏感：手写 YAML 时 `Advanced` 很常见，没必要因此降级成 basic。
  return value.trim().toLowerCase() === 'advanced' ? 'advanced' : 'basic';
}

/**
 * 发一个 JSON POST 到 Tavily 的某个路径。
 *
 * 具体的超时组合、非 2xx 错误体、`status` / `Retry-After` 挂载都在 `lib/rest.js`——
 * 三家供应商共用一份，避免「改了一家漏了两家」。
 * @param path - 相对路径，如 `/search`。
 * @param apiKey - 明文 key（只在内存里活一次调用）。
 * @param body - 请求体。
 * @param options - `{signal, timeoutMs}`。
 * @returns 解析后的 JSON。
 */
function postTavily(path, apiKey, body, { signal, timeoutMs }) {
  return postJson({
    url: `${TAVILY_BASE_URL}${path}`,
    label: `Tavily ${path}`,
    headers: { 'user-agent': USER_AGENT, authorization: `Bearer ${apiKey}` },
    body,
    signal,
    timeoutMs,
  });
}

/**
 * 调 `/search`。
 * @param options - `{apiKey, query, maxResults, signal, timeoutMs}`。
 * @returns `{content?, sources, truncated}`，即 seam 的 `WebSearchResult` 形状。
 */
export async function searchTavily({ apiKey, query, maxResults, signal, timeoutMs }) {
  const body = { query, include_usage: true };
  // 官方范围 0–20，越界会被 400 拒掉整次搜索。工具层给的 maxResults 可能更大，
  // 所以夹取而不是透传——多要几条不该让整次搜索失败。
  if (Number.isInteger(maxResults) && maxResults > 0) body.max_results = Math.min(maxResults, MAX_RESULTS);
  const parsed = await postTavily('/search', apiKey, body, { signal, timeoutMs });
  // 200 但响应体是错误时，不能当成「零结果」——那样用户拿到空结果、链也不降级。
  const bad = errorPayload(parsed, ['results']);
  if (bad !== undefined) throw requestFailure('Tavily /search', bad);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const sources = results.flatMap((item) => {
    if (item === null || typeof item !== 'object' || typeof item.url !== 'string') return [];
    const source = { url: item.url };
    if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title;
    if (typeof item.content === 'string' && item.content.length > 0) source.snippet = item.content;
    if (typeof item.published_date === 'string' && item.published_date.length > 0) source.publishedAt = item.published_date;
    return [source];
  });
  const out = { sources, truncated: false };
  if (typeof parsed?.answer === 'string' && parsed.answer.length > 0) out.content = parsed.answer;
  return out;
}

/**
 * 调 `/extract`。
 *
 * 返回值区分三态，交给 `shouldEscalate` 判定：
 * - 抛错 → 上层拿到异常；
 * - `failed_results` 非空 → `{content: '', failed: [...]}`；
 * - 成功 → `{content, failed: []}`。
 * @param options - `{apiKey, url, depth, signal, timeoutMs}`。
 * @returns `{content, failed}`。
 */
export async function extractTavily({ apiKey, url, depth, signal, timeoutMs }) {
  const body = { urls: [url] };
  if (depth === 'advanced') body.extract_depth = 'advanced';
  // 服务端超时（秒，官方范围 1.0–60.0）。不传就只有本地 AbortSignal 在断连，
  // 服务端仍会把这次抽取跑完——钱照扣，结果没人收。所以按本地预算换成秒传上去，
  // 且比本地略短，让服务端先收口。
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    body.timeout = Math.min(60, Math.max(1, Math.floor(timeoutMs / 1000)));
  }
  const parsed = await postTavily('/extract', apiKey, body, { signal, timeoutMs });

  const failed = Array.isArray(parsed?.failed_results) ? parsed.failed_results : [];
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const first = results.find((item) => item !== null && typeof item === 'object' && typeof item.raw_content === 'string');

  if (failed.length > 0 && first === undefined) {
    return { content: '', failed };
  }
  if (first === undefined) {
    // 既没有结果也没有失败列表：按「抽不出来」处理，让上层升级
    return { content: '', failed: [{ url, error: 'Tavily returned no extracted content' }] };
  }
  return { content: first.raw_content, failed };
}
