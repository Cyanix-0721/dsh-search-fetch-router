/**
 * 三家供应商共用的 JSON POST 底座。
 *
 * **为什么抽出来**：Tavily / Exa / Firecrawl 的请求-响应处理曾经是逐字重复的三份——
 * 组合超时、包网络错误、截断非 2xx 的错误体、挂 `status`、包「不是 JSON」。
 * 重复的代价不是行数，而是**修一处漏两处**：给 Tavily 的 429 加 `Retry-After` 时，
 * Exa 和 Firecrawl 就没有——同一类失败在 key 池里表现出两种冷却时长。
 * 抽到这里之后，任何「所有上游都该一致」的行为只改一处。
 *
 * 只做 HTTP 层的事：不解析业务响应、不决定重试策略。业务映射留在各供应商模块里。
 *
 * @module dsh-search-fetch-router/rest
 */

/**
 * 发给上游的 User-Agent。
 *
 * **只在这里定义**：曾经三家供应商各自写一份，结果 `package.json` 升到
 * `0.1.0-alpha.0` 时三处还停在 `0.1.0`，没人记得一起改。版本号漂移是
 * `test/rest.test.js` 会抓的东西——那里直接比对 `package.json` 的 `version`。
 */
export const USER_AGENT = 'dsh-search-fetch-router/0.1.0-alpha.0';

/** 错误体最多留多少字符。够看清原因，又不至于把整页 HTML 塞进报错。 */
const DETAIL_CHARS = 300;

/** 未给超时时的兜底毫秒数。没有超时的 `AbortSignal.timeout` 会直接抛。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 认出「HTTP 200 但响应体其实是错误」的响应，返回错误文案；正常响应返回 `undefined`。
 *
 * **为什么需要**：三家供应商正常报错都用 4xx/5xx，但都出现过 200 + 错误体的情况
 * （Firecrawl 的 `{success:false,error}` 尤其常见）。各家搜索映射对「结果字段不是数组」
 * 一律回退成空数组，于是「上游出错了」和「确实一条都没搜到」在调用方看来一模一样——
 * 用户拿到空结果，链也不会降级，故障被静默吞掉。
 *
 * 判定刻意保守：必须**存在**错误字段，且**完全没有**任何结果字段，才认作错误体。
 * 空 `{results: []}` 仍是合法的「零结果」，不能被误判（那会让正常的空搜索去降级）。
 *
 * @param parsed - 已解析的 JSON。
 * @param resultKeys - 该端点的结果字段名，如 `['results']`、`['data']`。
 * @returns 错误文案，或 `undefined` 表示响应正常。
 */
export function errorPayload(parsed, resultKeys) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const hasResults = resultKeys.some((key) => parsed[key] !== undefined && parsed[key] !== null);
  if (hasResults) return undefined;
  if (parsed.success === false) {
    const why = [parsed.error, parsed.message, parsed.details].find(
      (value) => typeof value === 'string' && value.trim().length > 0,
    );
    return why === undefined ? 'upstream reported success: false' : why.trim();
  }
  for (const key of ['error', 'detail', 'message']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (value !== null && typeof value === 'object') {
      const nested = value.message ?? value.detail ?? value.error;
      if (typeof nested === 'string' && nested.trim().length > 0) return nested.trim();
    }
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const first = parsed.errors[0];
    const text = typeof first === 'string' ? first : (first?.message ?? first?.detail);
    if (typeof text === 'string' && text.trim().length > 0) return text.trim();
  }
  return undefined;
}

/**
 * 把一个「200 但其实是错误」的响应包成异常。
 *
 * 打上 `requestLevel` 标记：这是**请求级**失败，不是「这把 key 坏了」。执行层看到这个
 * 标记就不该惩罚 key——否则一次上游软错误会把整池 key 打进冷却。
 * @param label - 错误文案前缀。
 * @param reason - 上游给的原因。
 * @returns 带 `requestLevel` 的 `Error`。
 */
export function requestFailure(label, reason) {
  const failure = new Error(`${label} reported an error: ${reason}`);
  failure.requestLevel = true;
  return failure;
}

/**
 * 发一个 JSON POST 并解析响应。
 *
 * 失败一律抛 `Error`，带两个可选字段供 key 池判断：
 * - `status`：HTTP 状态码（网络层失败没有）；
 * - `retryAfterMs`：上游给了 `Retry-After` 头时才有，单位毫秒。
 *
 * @param options - 请求参数。
 * @param options.url - 完整端点 URL。
 * @param options.label - 错误文案前缀，如 `Tavily /search`。**改动它会改变报错文案**，
 *   而文案是排查时的锚点，也出现在测试断言里。
 * @param options.headers - 额外请求头（认证等）。`content-type` / `accept` 由这里补。
 * @param options.body - 请求体，会被 `JSON.stringify`。
 * @param options.signal - 调用方取消信号。
 * @param options.timeoutMs - 本段超时毫秒；非正数时用兜底值。
 * @returns 解析后的 JSON（可能是任意形状，由调用方自己校验）。
 */
export async function postJson({ url, label, headers, body, signal, timeoutMs }) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(ms);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // 不跟重定向：API 端点不该跳转，真跳了说明配置或网关有问题，跟着走反而危险。
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    // 调用方取消必须**原样**抛。上层靠 `error.name === 'AbortError'` 判断「是不是用户取消」，
    // 包一层就变成普通 Error——取消会被当成后端失败，于是惩罚 key、继续降级，
    // 用户按了停止却还在往下一家打。本地超时抛的是 `TimeoutError`，不走这条。
    if (error instanceof Error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) throw error;
    const failure = new Error(
      `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    failure.cause = error;
    // 本地超时（`AbortSignal.timeout`）抛的是 `TimeoutError`，包一层就丢了名字。
    // key 池靠这个标记区分「这次慢」和「这把 key 坏了」——前者只该短暂冷却。
    if (error instanceof Error && error.name === 'TimeoutError') failure.timeout = true;
    throw failure;
  }

  if (!response.ok) {
    let detail;
    try {
      detail = (await response.text()).slice(0, DETAIL_CHARS);
    } catch {
      detail = undefined;
    }
    const failure = new Error(
      `${label} returned HTTP ${response.status}${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`,
    );
    failure.status = response.status;
    // 429 时上游会带 Retry-After（秒）。它是最准的等待时间——不同限流规则不同，
    // 用固定冷却不是太久就是太短。读不到就留给 key 池按失败性质分档。
    const retryAfter = Number(response.headers?.get?.('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) failure.retryAfterMs = retryAfter * 1000;
    throw failure;
  }

  try {
    return await response.json();
  } catch (error) {
    const failure = new Error(`${label} returned a body that is not JSON`);
    failure.status = response.status;
    failure.cause = error;
    throw failure;
  }
}
