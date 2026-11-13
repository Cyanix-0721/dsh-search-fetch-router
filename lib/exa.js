/**
 * Exa REST：`POST /search`（语义 / 神经搜索）。
 *
 * 认证用 `x-api-key: <key>` 头；body：`{ query, type, numResults, contents }`，
 * `type` 由配置 `exaSearchType` 决定（默认 `auto`，见 {@link EXA_SEARCH_TYPES}）。
 * `numResults` 上限 100（多于 10 条会额外计费），这里夹在 1..100。
 * 响应形状：`{ results: [{ title, url, publishedDate, author, id, text, summary, highlights }] }`。
 *
 * 官方文档：https://exa.ai/docs/reference/search
 *
 * @module dsh-search-fetch-router/exa
 */

import { postJson, USER_AGENT } from './rest.js';

/** 默认端点。设置里不暴露，改端点没有正当用途。 */
export const EXA_BASE_URL = 'https://api.exa.ai';

/** Exa 单次 `numResults` 上限（官方文档：max 100）。 */
const MAX_RESULTS = 100;

/** 每条结果取一段文本做 snippet 的字符上限，别把整页塞进搜索结果。 */
const SNIPPET_CHARS = 1_000;

/**
 * 官方支持的 `type` 取值（`POST /search` 的 `type` 字段）。
 *
 * 价格与延迟差别很大：`instant` / `fast` 最便宜也最快，`auto` 是官方默认的平衡档，
 * `deep*` 会做多步研究、明显更贵。所以这里**不做默认外的任何猜测**——配置里给了
 * 合法值就照用，给了别的（拼错、旧版本残留）就退回 `auto`，绝不把非法值发给上游
 * （上游对未知 type 是 400，那会把整次搜索变成一次失败）。
 */
export const EXA_SEARCH_TYPES = Object.freeze([
  'instant',
  'fast',
  'auto',
  'deep-lite',
  'deep',
  'deep-reasoning',
]);

/** 合法 `type` 的查表集合。 */
const SEARCH_TYPE_SET = new Set(EXA_SEARCH_TYPES);

/**
 * 规整 `type`：合法值（去掉首尾空格后）原样返回，其余一律 `auto`。
 * @param value - 配置里读到的任意值。
 * @returns 一个官方接受的 `type` 字符串。
 */
export function normalizeSearchType(value) {
  if (typeof value !== 'string') return 'auto';
  // 手改 YAML / 设置表单时很容易带首尾空格，trim 后再判断，别把 `deep-lite ` 当成非法。
  const trimmed = value.trim();
  return SEARCH_TYPE_SET.has(trimmed) ? trimmed : 'auto';
}

/**
 * 截断字符串，非字符串一律当空。
 * @param value - 任意值。
 * @param limit - 最大字符数。
 * @returns 截断后的字符串。
 */
function truncateText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * 发一个 JSON POST 到 Exa 的某个路径。
 *
 * 超时组合、非 2xx 错误体、`status` / `Retry-After` 挂载都在 `lib/rest.js`——三家共用一份。
 * @param path - 相对路径，如 `/search`。
 * @param apiKey - 明文 key。
 * @param body - 请求体。
 * @param options - `{signal, timeoutMs, label}`；`label` 决定报错文案前缀。
 * @returns 解析后的 JSON。
 */
function postExa(path, apiKey, body, { signal, timeoutMs, label }) {
  return postJson({
    url: `${EXA_BASE_URL}${path}`,
    label,
    headers: { 'user-agent': USER_AGENT, 'x-api-key': apiKey },
    body,
    signal,
    timeoutMs,
  });
}

/**
 * 调 Exa 的 search。
 * @param options - `{apiKey, query, maxResults, signal, timeoutMs, type}`。
 *   `type` 缺省/非法时按 `auto`（见 {@link normalizeSearchType}）。
 * @returns `{sources, truncated}`，即 seam 的 `WebSearchResult` 形状。
 */
export async function searchExa({ apiKey, query, maxResults, signal, timeoutMs, type }) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000;

  const requested = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 10;
  const body = {
    query: typeof query === 'string' ? query : String(query ?? ''),
    type: normalizeSearchType(type),
    numResults: Math.min(requested, MAX_RESULTS),
    contents: { text: { maxCharacters: SNIPPET_CHARS } },
  };

  const parsed = await postExa('/search', apiKey, body, { signal, timeoutMs: ms, label: 'Exa search' });

  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const sources = results.flatMap((item) => {
    if (item === null || typeof item !== 'object' || typeof item.url !== 'string') return [];
    const source = { url: item.url };
    if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title;
    const snippet = truncateText(item.text, SNIPPET_CHARS)
      || (typeof item.summary === 'string' ? item.summary : '')
      || (Array.isArray(item.highlights) && typeof item.highlights[0] === 'string' ? item.highlights[0] : '');
    if (snippet.length > 0) source.snippet = snippet;
    if (typeof item.publishedDate === 'string' && item.publishedDate.length > 0) source.publishedAt = item.publishedDate;
    return [source];
  });
  return { sources, truncated: false };
}

/**
 * 调 `/contents`：给一个 URL 取正文。
 *
 * 文档（POST /contents）：body `{ urls:[url], text:{ maxCharacters } }`；
 * 响应 `{ results: [{ url, title?, text, ... }] }`（失败 URL 可能不带 text）。
 * @param options - `{apiKey, url, signal, timeoutMs, maxBodyChars}`。
 * @returns `{content, failure}`：`content` 取第一条结果的 text（没有则空串）；
 *   `failure` 是从 `statuses` 读到的失败原因（全部成功则 `undefined`）。
 */
export async function contentsExa({ apiKey, url, signal, timeoutMs, maxBodyChars }) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000;
  const maxCharacters = Number.isFinite(maxBodyChars) && maxBodyChars > 0 ? maxBodyChars : 100_000;

  const payload = await postExa('/contents', apiKey, {
    urls: [url],
    text: { maxCharacters },
    // 服务端自己的 livecrawl 超时（文档默认 10000ms，上限 90000）。不传的话我们只靠本地
    // AbortSignal 断连，服务端仍在爬，那一次调用照旧计费。超过上限会让上游 400，故夹住。
    livecrawlTimeout: Math.min(ms, 90_000),
  }, { signal, timeoutMs: ms, label: 'Exa contents' });

  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined;
  const content = first !== null && typeof first?.text === 'string' ? first.text : '';
  return { content, failure: readContentsFailure(payload) };
}

/**
 * 从 `/contents` 响应的 `statuses` 里读失败原因。
 *
 * 为什么需要：`/contents` 抓不到某个 URL 时**不一定**返回非 2xx——它可能整体 200，
 * 把该 URL 放进 `statuses` 并给出 `error.tag`，而 `results` 里没有它。只看
 * `results[0].text` 的话，这种情况和「页面确实是空的」长得一模一样，报错会变成
 * 一句没用的「empty body」。这里把上游给的真实原因捞出来，让失败可诊断。
 *
 * 响应形状：`{ results: [...], statuses: [{ id, status, source, error: { tag, httpStatusCode } }] }`。
 * @param payload - 已解析的响应体。
 * @returns 失败原因字符串；全部成功或读不到时 `undefined`。
 */
function readContentsFailure(payload) {
  const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
  for (const entry of statuses) {
    if (entry === null || typeof entry !== 'object') continue;
    const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : '';
    if (status === 'success' || status.length === 0) continue;
    const tag = typeof entry.error?.tag === 'string' ? entry.error.tag.trim() : '';
    const httpStatus = entry.error?.httpStatusCode;
    if (tag.length > 0) return tag;
    if (Number.isInteger(httpStatus)) return `upstream reported HTTP ${httpStatus}`;
    return `upstream reported status "${entry.status}"`;
  }
  return undefined;
}
