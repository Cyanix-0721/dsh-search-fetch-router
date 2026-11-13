/**
 * Firecrawl REST：`/v2/scrape`。
 *
 * 与官方 `@firecrawl/dsh-firecrawl` 的实现对齐（请求体字段名、响应映射、
 * `metadata.statusCode` 回退规则），但**不复用它的包**——那个包的
 * peerDependencies 锁死在 DSH 0.1.0-rc.6，比当前宿主老两个 rc。
 *
 * @module dsh-search-fetch-router/firecrawl
 */

/** 默认端点。 */
const USER_AGENT = 'dsh-search-fetch-router/0.1.0';

export const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';

/**
 * 构造 `/v2/scrape` 的请求体。
 * @param url - 目标 URL。
 * @param options - `{onlyMainContent, maxAgeMs, timeoutMs}`。
 * @returns 请求体。
 */
export function buildScrapeBody(url, { onlyMainContent, maxAgeMs, timeoutMs }) {
  // 文档：timeout 取值 1000..300000，越界上游直接 400。段预算可能很小，必须夹住。
  const timeout = Number.isFinite(timeoutMs) ? Math.min(Math.max(Math.round(timeoutMs), 1_000), 300_000) : 60_000;
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
 * @param payload - 已解析的 JSON。
 * @param requestedUrl - 请求时用的 URL，作为 `url` 的兜底。
 * @param options - `{maxBodyChars}`。
 * @returns `{url, statusCode, body, truncated}`。
 */
export function mapScrapeResponse(payload, requestedUrl, { maxBodyChars }) {
  const data = payload?.data;
  if (data === null || typeof data !== 'object') {
    throw new TypeError('Firecrawl response.data is missing');
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
 * @returns `{result, empty}`：`result` 是映射后的抓取结果，`empty` 表示正文为空。
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
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetch(`${FIRECRAWL_BASE_URL}/v2/scrape`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'user-agent': USER_AGENT,
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildScrapeBody(url, { onlyMainContent, maxAgeMs, timeoutMs })),
      signal: combined,
    });
  } catch (error) {
    const failure = new Error(
      `Firecrawl scrape request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
      `Firecrawl scrape returned HTTP ${response.status}${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`,
    );
    failure.status = response.status;
    throw failure;
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const failure = new Error('Firecrawl scrape returned a body that is not JSON');
    failure.status = response.status;
    failure.cause = error;
    throw failure;
  }
  const result = mapScrapeResponse(payload, url, { maxBodyChars });
  return { result, empty: result.body.content.trim().length === 0, failure: result.failure };
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
  const timeout = AbortSignal.timeout(ms);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const limit = Number.isInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, 100) : 10;

  let response;
  try {
    response = await fetch(`${FIRECRAWL_BASE_URL}/v2/search`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'user-agent': USER_AGENT,
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      // `timeout` 是文档支持的服务端超时（毫秒）：本地的 AbortSignal 只能保护我们自己，
      // 服务端如果卡在爬取上，带这个参数能让它自己早退，而不是等我们断连。
      body: JSON.stringify({
        query: typeof query === 'string' ? query : String(query ?? ''),
        limit,
        timeout: ms,
      }),
      signal: combined,
    });
  } catch (error) {
    const failure = new Error(
      `Firecrawl search request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
      `Firecrawl search returned HTTP ${response.status}${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`,
    );
    failure.status = response.status;
    throw failure;
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const failure = new Error('Firecrawl search returned a body that is not JSON');
    failure.status = response.status;
    failure.cause = error;
    throw failure;
  }
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
