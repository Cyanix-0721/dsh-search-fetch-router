/**
 * 执行层：把纯决策（`lib/router.js`）落到真实调用上。
 *
 * 三条不变量：
 * 1. **失败一律降级，不冒泡**——`available()` 恒 true，被 pin 的 provider 抛错会
 *    直接毁掉 `web_search`/`web_fetch`，所以每一档都要 try/catch，最后才抛汇总错误。
 * 2. **每次调用读一次配置**——设置页改了 refs 或阈值，下一次调用就生效，不需要
 *    重新注册 provider。
 * 3. **总预算硬上限**——每段拿 `min(段上限, 剩余)`，剩余不足就不开新段。工具层自己的
 *    `fetchTimeoutMs` 是外层闸，这里是内层闸，两者都设才不会被中途腰斩。
 *
 * @module dsh-search-fetch-router/execute
 */

import { MIN_SEGMENT_BUDGET_MS } from './config.js';
import { asWebError, CODES, isAbortError, webError } from './errors.js';
import { scrapeFirecrawl } from './firecrawl.js';
import { KeyRing } from './keyring.js';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { createOfficialFetchProvider, createOfficialSearchProvider } from './official.js';
import {
  FETCH_BACKENDS,
  planFetchChain,
  planSearchChain,
  SEARCH_BACKENDS,
  segmentTimeout,
  shouldEscalate,
} from './router.js';
import { extractTavily, searchTavily } from './tavily.js';
import { assertFetchableUrl, matchesAnyPattern } from './urls.js';

/**
 * 读一个配置字段的当前值。`config` 是 schemastery 实例，字段是响应式的，
 * 因此每次调用都要重新 `.get()`，不能提前快照。
 * @param config - 插件配置。
 * @param key - 字段名。
 * @returns 当前值。
 */
function read(config, key) {
  const field = config?.[key];
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get();
  return field;
}

/**
 * 读一个数字字段，非法时用兜底值。
 * @param config - 插件配置。
 * @param key - 字段名。
 * @param fallback - 兜底值。
 * @returns 正整数。
 */
function readNumber(config, key, fallback) {
  const value = read(config, key);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 读一个数组字段，规整成字符串数组。
 * @param config - 插件配置。
 * @param key - 字段名。
 * @returns 字符串数组。
 */
function readStrings(config, key) {
  const value = read(config, key);
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
}

/**
 * 把超时切成「信号 + 剩余预算」。
 * @param signal - 调用方信号。
 * @param ms - 本段毫秒。
 * @returns 组合信号。
 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * 建一个凭据解析器：ref 名 → 值。
 *
 * 引用名不在语法里（比如用户写了个带空格的）时**不抛**，当作没配——一个手滑的
 * 引用名不该让整条链挂掉。
 *
 * 用 `ctx.get('credentials')` 而不是 `ctx.credentials`：后者需要 `inject` 声明，
 * 而 `credentials` 是可选能力（宿主没挂 `dsh-credentials-local` 时也得能跑）。
 * @param ctx - 插件上下文。
 * @returns 异步解析函数。
 */
function makeCredentialResolver(ctx) {
  return async (ref) => {
    try {
      const credentials = ctx.get?.('credentials');
      const resolved = await credentials?.resolve?.(ref);
      if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value;
    } catch {
      // 语法不合法或服务未挂载：当作没配
    }
    // 兜底查环境层（credentials 服务不在时也能用 `export TAVILY_API_KEY=...`）
    const fromEnv = launchEnvironmentOf(ctx)?.get?.(ref)?.value;
    return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
  };
}

/**
 * 按 ref 列表缓存一个 KeyRing。
 *
 * 池的状态（游标、冷却、永久失效）**必须跨调用存活**，否则每次调用都从第一把 key
 * 开始，「轮转」和「冷却」就是空话。但配置是响应式的——用户在设置页改了 ref 列表或
 * 冷却时长，池必须重建。所以按「列表 + 冷却时长」的签名缓存：签名不变就复用同一个实例。
 */
class RingCache {
  /** 当前缓存：`{signature, ring}`。 */
  current;

  /**
   * 取当前配置对应的池，必要时重建。
   * @param refs - 配置里的 ref 名数组。
   * @param resolve - 引用名解析函数。
   * @param cooldownMs - 冷却时长（毫秒）。
   * @returns `KeyRing` 实例。
   */
  of(refs, resolve, cooldownMs) {
    const signature = `${refs.join('\u0000')}\u0001${cooldownMs}`;
    if (this.current?.signature === signature) return this.current.ring;
    const ring = new KeyRing({ refs, resolve, cooldownMs });
    this.current = { signature, ring };
    return ring;
  }
}

/**
 * 建路由对象。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @returns `{search, fetch}`，两个方法都返回 seam 期望的形状。
 */
export function createRouter(ctx, config) {
  const resolveCredential = makeCredentialResolver(ctx);

  // 池活在 createRouter 的闭包里，跨调用共享状态；配置变了由 RingCache 重建。
  const tavilyRings = new RingCache();
  const firecrawlRings = new RingCache();

  /**
   * 取 Tavily 池的当前实例。
   * @returns `KeyRing`。
   */
  const tavilyRing = () => tavilyRings.of(
    readStrings(config, 'tavilyApiKeyRefs'),
    resolveCredential,
    readNumber(config, 'cooldownMs', 60_000),
  );

  /**
   * 取 Firecrawl 池的当前实例。
   * @returns `KeyRing`。
   */
  const firecrawlRing = () => firecrawlRings.of(
    readStrings(config, 'firecrawlApiKeyRefs'),
    resolveCredential,
    readNumber(config, 'cooldownMs', 60_000),
  );

  /**
   * 搜索：Tavily 池 → 官方。
   * @param request - `WebSearchRequest`。
   * @param signal - 取消信号。
   * @returns `WebSearchResult`。
   */
  async function search(request, signal) {
    const fallback = read(config, 'searchFallback') !== false;
    const ring = tavilyRing();
    const timeoutMs = readNumber(config, 'tavilyTimeoutMs', 15_000);

    // 先解析再决策：ref 名字存在不代表解析得到值（默认 ref 名永远存在，但用户可能
    // 根本没填过）。用「解析出的 key 数」而不是「ref 名数」决定链里有没有 Tavily。
    const tavilyCandidates = await ring.resolvedCandidates();

    const officialProvider = createOfficialSearchProvider(ctx);
    const hasOfficial = (() => {
      try {
        return officialProvider.available() === true;
      } catch {
        return false;
      }
    })();

    const chain = planSearchChain({ hasTavily: tavilyCandidates.length > 0, hasOfficial, fallback });
    if (chain.length === 0) {
      throw webError(
        'no web search provider is usable: Tavily has no configured key reference and the '
          + 'official DeepSeek search provider is not configured either',
        CODES.SEARCH_ALL_FAILED,
      );
    }

    const failures = [];
    for (const backend of chain) {
      if (signal?.aborted === true) throw webError('web search aborted', CODES.ABORTED);
      try {
        if (backend === SEARCH_BACKENDS.tavily) {
          let lastError;
          for (const candidate of tavilyCandidates) {
            try {
              const result = await searchTavily({
                apiKey: candidate.value,
                query: request.query,
                maxResults: request.maxResults,
                signal,
                timeoutMs,
              });
              ring.advance(candidate.ref);
              return result;
            } catch (error) {
              if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
              ring.penalize(candidate.ref, error);
              lastError = error;
            }
          }
          failures.push({
            backend,
            message: lastError instanceof Error ? lastError.message : 'every Tavily key failed',
          });
          continue;
        }
        if (backend === SEARCH_BACKENDS.official) {
          return await officialProvider.search(request, signal);
        }
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
        failures.push({ backend, message: error instanceof Error ? error.message : String(error) });
      }
    }

    const summary = failures.map((item) => `${item.backend}: ${item.message}`).join('; ');
    const last = failures.length > 0 ? new Error(failures[failures.length - 1].message) : undefined;
    throw webError(`every web search backend failed (${summary})`, CODES.SEARCH_ALL_FAILED, last);
  }

  /**
   * 抓取：白名单直连 Firecrawl，否则 Tavily → Firecrawl → 本地 http。
   * @param request - `WebFetchRequest`（只有 `url`）。
   * @param signal - 取消信号。
   * @returns `WebFetchResult`。
   */
  async function fetchUrl(request, signal) {
    assertFetchableUrl(request.url, webError);

    const patterns = readStrings(config, 'firecrawlUrlPatterns');
    const fallback = read(config, 'fetchFallback') !== false;
    const totalBudgetMs = readNumber(config, 'totalBudgetMs', 45_000);
    const deadline = Date.now() + totalBudgetMs;
    const maxBodyChars = readNumber(config, 'maxBodyChars', 100_000);

    const tavilyPool = tavilyRing();
    const firecrawlPool = firecrawlRing();

    // 与搜索同样的理由：先解析再决策。默认 ref 名永远存在，`hasAnyConfigured()` 会
    // 恒真，于是「一个 key 都没填」会被当成「有 Tavily 可用」，最终报出一串没人看得懂
    // 的后端失败。用解析出的 key 数决策，才能给出「你还没配 key」这种能照做的错误。
    const tavilyCandidates = await tavilyPool.resolvedCandidates();
    const firecrawlCandidates = await firecrawlPool.resolvedCandidates();

    const chain = planFetchChain({
      url: request.url,
      patterns,
      hasFirecrawl: firecrawlCandidates.length > 0,
      hasTavily: tavilyCandidates.length > 0,
      hasHttp: fallback,
      fallback,
      matches: matchesAnyPattern,
    });

    if (chain.length === 0) {
      throw webError(
        'no web fetch provider is usable: no Tavily or Firecrawl key reference is configured '
          + 'and the local HTTP fallback is disabled',
        CODES.FETCH_ALL_FAILED,
      );
    }

    const failures = [];

    for (const backend of chain) {
      if (signal?.aborted === true) throw webError('web fetch aborted', CODES.ABORTED);

      if (backend === FETCH_BACKENDS.tavily) {
        const budget = segmentTimeout({
          remainingMs: deadline - Date.now(),
          segmentMs: readNumber(config, 'tavilyTimeoutMs', 15_000),
          minSegmentMs: MIN_SEGMENT_BUDGET_MS,
        });
        if (budget === null) {
          failures.push({ backend, message: 'skipped: fetch budget exhausted' });
          continue;
        }
        let escalated = false;
        let lastError;
        for (const candidate of tavilyCandidates) {
          try {
            const extract = await extractTavily({
              apiKey: candidate.value,
              url: request.url,
              depth: read(config, 'tavilyExtractDepth') === 'advanced' ? 'advanced' : 'basic',
              signal,
              timeoutMs: budget,
            });
            if (shouldEscalate(extract, readNumber(config, 'minContentChars', 0))) {
              escalated = true;
              failures.push({
                backend,
                message: `extracted content is unusable (${extract.failed.length > 0 ? 'failed_results non-empty' : 'content too short'})`,
              });
              break;
            }
            tavilyPool.advance(candidate.ref);
            const truncated = extract.content.length > maxBodyChars;
            return {
              url: request.url,
              statusCode: 200,
              body: { kind: 'text', content: truncated ? extract.content.slice(0, maxBodyChars) : extract.content },
              truncated,
            };
          } catch (error) {
            if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
            tavilyPool.penalize(candidate.ref, error);
            lastError = error;
          }
        }
        if (!escalated && lastError !== undefined) {
          failures.push({ backend, message: lastError instanceof Error ? lastError.message : String(lastError) });
        }
        continue;
      }

      if (backend === FETCH_BACKENDS.firecrawl) {
        const budget = segmentTimeout({
          remainingMs: deadline - Date.now(),
          segmentMs: readNumber(config, 'firecrawlTimeoutMs', 30_000),
          minSegmentMs: MIN_SEGMENT_BUDGET_MS,
        });
        if (budget === null) {
          failures.push({ backend, message: 'skipped: fetch budget exhausted' });
          continue;
        }
        let lastError;
        for (const candidate of firecrawlCandidates) {
          try {
            const { result, empty } = await scrapeFirecrawl({
              apiKey: candidate.value,
              url: request.url,
              onlyMainContent: read(config, 'firecrawlOnlyMainContent') !== false,
              maxAgeMs: Number.isFinite(read(config, 'firecrawlMaxAgeMs')) ? read(config, 'firecrawlMaxAgeMs') : 172_800_000,
              timeoutMs: budget,
              maxBodyChars,
              signal,
            });
            if (empty) {
              failures.push({ backend, message: 'Firecrawl returned an empty body' });
              break;
            }
            firecrawlPool.advance(candidate.ref);
            return result;
          } catch (error) {
            if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
            firecrawlPool.penalize(candidate.ref, error);
            lastError = error;
          }
        }
        if (lastError !== undefined) {
          failures.push({ backend, message: lastError instanceof Error ? lastError.message : String(lastError) });
        }
        continue;
      }

      if (backend === FETCH_BACKENDS.http) {
        const budget = segmentTimeout({
          remainingMs: deadline - Date.now(),
          segmentMs: readNumber(config, 'httpTimeoutMs', 10_000),
          minSegmentMs: MIN_SEGMENT_BUDGET_MS,
        });
        if (budget === null) {
          failures.push({ backend, message: 'skipped: fetch budget exhausted' });
          continue;
        }
        try {
          const provider = createOfficialFetchProvider();
          return await provider.fetch(request, withTimeout(signal, budget));
        } catch (error) {
          if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
          failures.push({ backend, message: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
    }

    const summary = failures.map((item) => `${item.backend}: ${item.message}`).join('; ');
    const exhausted = failures.length > 0 && failures.every((item) => item.message.startsWith('skipped:'));
    const last = failures.length > 0 ? new Error(failures[failures.length - 1].message) : undefined;
    throw webError(
      exhausted
        ? `web fetch gave up after ${totalBudgetMs}ms without completing a single backend (${summary})`
        : `every web fetch backend failed (${summary})`,
      exhausted ? CODES.BUDGET_EXHAUSTED : CODES.FETCH_ALL_FAILED,
      last,
    );
  }

  return { search, fetch: fetchUrl };
}
