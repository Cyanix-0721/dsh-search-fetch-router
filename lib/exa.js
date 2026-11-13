/**
 * Exa REST：`POST /search`（语义 / 神经搜索）。
 *
 * 认证用 `x-api-key: <key>` 头；body：`{ query, type:'auto', numResults, contents }`。
 * `numResults` 上限 100（多于 10 条会额外计费），这里夹在 1..100。
 * 响应形状：`{ results: [{ title, url, publishedDate, author, id, text, summary, highlights }] }`。
 *
 * 官方文档：https://exa.ai/docs/reference/search
 *
 * @module dsh-search-fetch-router/exa
 */

/** 默认端点。设置里不暴露，改端点没有正当用途。 */
export const EXA_BASE_URL = 'https://api.exa.ai';

/** Exa 单次 `numResults` 上限（官方文档：max 100）。 */
const MAX_RESULTS = 100;

/** 每条结果取一段文本做 snippet 的字符上限，别把整页塞进搜索结果。 */
const SNIPPET_CHARS = 1_000;

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
 * 调 Exa 的 search。
 * @param options - `{apiKey, query, maxResults, signal, timeoutMs}`。
 * @returns `{sources, truncated}`，即 seam 的 `WebSearchResult` 形状。
 */
export async function searchExa({ apiKey, query, maxResults, signal, timeoutMs }) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000;
  const timeout = AbortSignal.timeout(ms);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  const requested = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 10;
  const body = {
    query: typeof query === 'string' ? query : String(query ?? ''),
    type: 'auto',
    numResults: Math.min(requested, MAX_RESULTS),
    contents: { text: { maxCharacters: SNIPPET_CHARS } },
  };

  let response;
  try {
    response = await fetch(`${EXA_BASE_URL}/search`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    const failure = new Error(`Exa search request failed: ${error instanceof Error ? error.message : String(error)}`);
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
      `Exa search returned HTTP ${response.status}${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`,
    );
    failure.status = response.status;
    throw failure;
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch (error) {
    const failure = new Error('Exa search returned a body that is not JSON');
    failure.status = response.status;
    failure.cause = error;
    throw failure;
  }

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
