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

/** 默认端点。设置里不暴露，改端点没有正当用途。 */
const USER_AGENT = 'dsh-search-fetch-router/0.1.0';

export const TAVILY_BASE_URL = 'https://api.tavily.com';

/**
 * 发一个 JSON POST，把非 2xx 转成带 status 的错误。
 * @param path - 相对路径，如 `/search`。
 * @param apiKey - 明文 key（只在内存里活一次调用）。
 * @param body - 请求体。
 * @param options - `{signal, timeoutMs}`。
 * @returns 解析后的 JSON。
 */
async function postJson(path, apiKey, body, { signal, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetch(`${TAVILY_BASE_URL}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'user-agent': USER_AGENT,
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    const failure = new Error(`Tavily ${path} request failed: ${error instanceof Error ? error.message : String(error)}`);
    failure.cause = error;
    throw failure;
  }
  if (!response.ok) {
    let detail;
    try {
      const text = await response.text();
      detail = text.slice(0, 300);
    } catch {
      detail = undefined;
    }
    const failure = new Error(
      `Tavily ${path} returned HTTP ${response.status}${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`,
    );
    failure.status = response.status;
    throw failure;
  }
  try {
    return await response.json();
  } catch (error) {
    const failure = new Error(`Tavily ${path} returned a body that is not JSON`);
    failure.status = response.status;
    failure.cause = error;
    throw failure;
  }
}

/**
 * 调 `/search`。
 * @param options - `{apiKey, query, maxResults, signal, timeoutMs}`。
 * @returns `{content?, sources, truncated}`，即 seam 的 `WebSearchResult` 形状。
 */
export async function searchTavily({ apiKey, query, maxResults, signal, timeoutMs }) {
  const body = { query, include_usage: true };
  if (Number.isInteger(maxResults) && maxResults > 0) body.max_results = maxResults;
  const parsed = await postJson('/search', apiKey, body, { signal, timeoutMs });
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
  const parsed = await postJson('/extract', apiKey, body, { signal, timeoutMs });

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
