/**
 * Brave Search REST：`/res/v1/web/search`。
 *
 * 认证用 `X-Subscription-Token: <key>` 头（**不是** `Authorization: Bearer`，用错会 401）。
 * 端点是 GET，`q` 必填，`count` 上限 20（web 结果）。
 * 响应形状：`{ web: { results: [{ title, url, description, extra_snippets? }] } }`。
 *
 * 官方文档：
 * - 认证：https://api-dashboard.search.brave.com/documentation/guides/authentication
 * - web search：https://api-dashboard.search.brave.com/api-reference/web/search/get
 *
 * @module dsh-search-fetch-router/brave
 */

/** 默认端点。设置里不暴露，改端点没有正当用途。 */
export const BRAVE_BASE_URL = 'https://api.search.brave.com';

/** Brave web search 的 `count` 上限（官方文档：max 20）。 */
const MAX_COUNT = 20;

/**
 * 构造请求 URL。
 * @param query - 搜索词。
 * @param maxResults - 期望条数；不给时用 10，夹在 1..20。
 * @returns {URL} 带好查询参数的 URL。
 */
function buildUrl(query, maxResults) {
  const url = new URL(`${BRAVE_BASE_URL}/res/v1/web/search`);
  url.searchParams.set('q', typeof query === 'string' ? query : String(query ?? ''));
  const requested = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 10;
  url.searchParams.set('count', String(Math.min(requested, MAX_COUNT)));
  return url;
}

/**
 * 调 Brave 的 web search。
 * @param options - `{apiKey, query, maxResults, signal, timeoutMs}`。
 * @returns `{sources, truncated}`，即 seam 的 `WebSearchResult` 形状（Brave 不返回拼好的答案）。
 */
export async function searchBrave({ apiKey, query, maxResults, signal, timeoutMs }) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000;
  const timeout = AbortSignal.timeout(ms);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response;
  try {
    response = await fetch(buildUrl(query, maxResults), {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'x-subscription-token': apiKey,
      },
      signal: combined,
    });
  } catch (error) {
    const failure = new Error(`Brave search request failed: ${error instanceof Error ? error.message : String(error)}`);
    failure.cause = error;
    throw failure;
  }

  if (!response.ok) {
    let detail;
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = undefined;
    }
    const failure = new Error(
      `Brave search returned HTTP ${response.status}${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`,
    );
    failure.status = response.status;
    throw failure;
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch (error) {
    const failure = new Error('Brave search returned a body that is not JSON');
    failure.status = response.status;
    failure.cause = error;
    throw failure;
  }

  const results = Array.isArray(parsed?.web?.results) ? parsed.web.results : [];
  const sources = results.flatMap((item) => {
    if (item === null || typeof item !== 'object' || typeof item.url !== 'string') return [];
    const source = { url: item.url };
    if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title;
    if (typeof item.description === 'string' && item.description.length > 0) source.snippet = item.description;
    return [source];
  });
  return { sources, truncated: false };
}
