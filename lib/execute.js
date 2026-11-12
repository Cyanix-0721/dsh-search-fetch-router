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
import { FETCH_BACKEND_IDS, lookupFetchBackend } from './fetch-backends.js';
import { KeyRing } from './keyring.js';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { planFetchChain, planSearchChain, segmentTimeout } from './router.js';
import { lookupSearchBackend, SEARCH_BACKEND_IDS } from './search-backends.js';
import { assertFetchableUrl } from './urls.js';

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
export function createRouter(ctx, config, options = {}) {
  const resolveCredential = makeCredentialResolver(ctx);
  // 搜索后端注册表可注入——测试用它在不改生产代码的前提下验证「新增供应商即生效」。
  // 生产默认走 search-backends.js 的 lookupSearchBackend（未知 id 返回 undefined，执行层跳过）。
  const lookupBackend = options.searchBackends === undefined
    ? lookupSearchBackend
    : (id) => options.searchBackends[id];

  // 每个后端一个 RingCache，活在 createRouter 的闭包里，跨调用共享池状态；配置变了
  // 由 RingCache 自己按签名重建。用 Map 分桶，不同供应商的 key 池互不串。
  const ringCaches = new Map();

  /**
   * 取某个 key 池对应的 RingCache（每个池一个实例）。
   * @param key - 池的稳定标识（通常就是后端 id）。
   * @returns `RingCache`。
   */
  function ringCacheFor(key) {
    let cache = ringCaches.get(key);
    if (cache === undefined) {
      cache = new RingCache();
      ringCaches.set(key, cache);
    }
    return cache;
  }

  /**
   * 取某个后端的当前 `KeyRing`。refs 列表或冷却时长变了就重建。
   * @param key - 池的稳定标识。
   * @param keyRefsField - 该后端 refs 数组所在的 config 字段名。
   * @returns `KeyRing`。
   */
  function ringFor(key, keyRefsField) {
    return ringCacheFor(key).of(
      readStrings(config, keyRefsField),
      resolveCredential,
      readNumber(config, 'cooldownMs', 60_000),
    );
  }

  /**
   * 搜索：按搜索后端注册表 + 用户配置的顺序遍历。
   *
   * 数据驱动——每多一个供应商，只要注册表里多一项、配置里多一组字段，这里完全不变。
   * keyed 后端自动获得候选 key 轮转/冷却；keyless 后端（官方）单次调用。
   * @param request - `WebSearchRequest`。
   * @param signal - 取消信号。
   * @returns `WebSearchResult`。
   */
  async function search(request, signal) {
    const fallback = read(config, 'searchFallback') !== false;
    const fallbackId = SEARCH_BACKEND_IDS.official;
    const order = readStrings(config, 'searchProviderOrder');

    // 为 order 里每个已注册的后端准备运行时视图；未知 id 忽略。官方兜底即使没写进
    // order 也准备好，供末尾兜底使用。
    const readiness = new Map();
    const prepare = (backend) => {
      if (backend.keyRefsField === null) {
        readiness.set(backend.id, { backend, ring: null, candidates: [] });
      } else {
        readiness.set(backend.id, {
          backend,
          ring: ringFor(backend.id, backend.keyRefsField),
          candidates: null, // 稍后异步解析再填
        });
      }
    };
    for (const id of order) {
      const backend = lookupBackend(id);
      if (backend !== undefined) prepare(backend);
    }
    const fallbackBackend = lookupBackend(fallbackId);
    if (fallbackBackend !== undefined && !readiness.has(fallbackBackend.id)) prepare(fallbackBackend);

    // 先解析再决策：ref 名存在不代表解析得到值。只有 keyed 后端需要。
    for (const view of readiness.values()) {
      if (view.ring !== null) view.candidates = await view.ring.resolvedCandidates();
    }

    const availability = (id) => {
      const view = readiness.get(id);
      if (view === undefined) return false;
      const { backend, candidates } = view;
      if (backend.keyRefsField === null) {
        return typeof backend.isAvailable === 'function' ? backend.isAvailable(ctx) : true;
      }
      return candidates.length > 0;
    };

    const chain = planSearchChain({ order, isAvailable: availability, fallback, fallbackBackend: fallbackId });
    if (chain.length === 0) {
      throw webError(
        'no web search provider is usable: no configured key reference for a REST provider and '
          + 'the official DeepSeek search provider is not configured either',
        CODES.SEARCH_ALL_FAILED,
      );
    }

    const failures = [];
    for (const id of chain) {
      if (signal?.aborted === true) throw webError('web search aborted', CODES.ABORTED);
      const { backend, ring, candidates } = readiness.get(id);
      try {
        if (ring !== null) {
          // keyed：轮转候选 key，成功即 advance，失败换下一把。
          let lastError;
          for (const candidate of candidates) {
            try {
              const result = await backend.run({
                apiKey: candidate.value,
                ctx,
                request,
                signal,
                timeoutMs: readNumber(config, backend.timeoutField, backend.defaultTimeoutMs),
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
            backend: id,
            message: lastError instanceof Error ? lastError.message : `every ${backend.label} key failed`,
          });
          continue;
        }
        // keyless：单次调用。
        return await backend.run({ ctx, request, signal });
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
        failures.push({ backend: id, message: error instanceof Error ? error.message : String(error) });
      }
    }

    const summary = failures.map((item) => `${item.backend}: ${item.message}`).join('; ');
    const last = failures.length > 0 ? new Error(failures[failures.length - 1].message) : undefined;
    throw webError(`every web search backend failed (${summary})`, CODES.SEARCH_ALL_FAILED, last);
  }

  /**
   * 抓取：固定顺序 Tavily → Firecrawl → 本地 http。
   * @param request - `WebFetchRequest`（只有 `url`）。
   * @param signal - 取消信号。
   * @returns `WebFetchResult`。
   */
  async function fetchUrl(request, signal) {
    assertFetchableUrl(request.url, webError);

    const fallback = read(config, 'fetchFallback') !== false;
    const totalBudgetMs = readNumber(config, 'totalBudgetMs', 45_000);
    const deadline = Date.now() + totalBudgetMs;
    const maxBodyChars = readNumber(config, 'maxBodyChars', 100_000);

    // 先解析再决策：ref 名存在不代表解析得到值（默认 ref 名永远存在，`hasAnyConfigured()`
    // 会恒真）。用解析出的 key 数决策，才能给出「你还没配 key」这种能照做的错误。
    const readiness = new Map();
    for (const id of [FETCH_BACKEND_IDS.tavily, FETCH_BACKEND_IDS.firecrawl]) {
      const backend = lookupFetchBackend(id);
      readiness.set(id, { backend, ring: ringFor(id, backend.keyRefsField), candidates: null });
    }
    for (const view of readiness.values()) view.candidates = await view.ring.resolvedCandidates();

    const chain = planFetchChain({
      hasFirecrawl: readiness.get(FETCH_BACKEND_IDS.firecrawl).candidates.length > 0,
      hasTavily: readiness.get(FETCH_BACKEND_IDS.tavily).candidates.length > 0,
      hasHttp: fallback,
      fallback,
    });

    if (chain.length === 0) {
      throw webError(
        'no web fetch provider is usable: no Tavily or Firecrawl key reference is configured '
          + 'and the local HTTP fallback is disabled',
        CODES.FETCH_ALL_FAILED,
      );
    }

    const failures = [];

    for (const id of chain) {
      if (signal?.aborted === true) throw webError('web fetch aborted', CODES.ABORTED);

      const backend = lookupFetchBackend(id);
      if (backend === undefined) {
        failures.push({ backend: id, message: 'unknown fetch backend' });
        continue;
      }

      const budget = segmentTimeout({
        remainingMs: deadline - Date.now(),
        segmentMs: readNumber(config, backend.timeoutField, backend.defaultTimeoutMs),
        minSegmentMs: MIN_SEGMENT_BUDGET_MS,
      });
      if (budget === null) {
        failures.push({ backend: id, message: 'skipped: fetch budget exhausted' });
        continue;
      }

      const view = readiness.get(id);
      const readValue = (key) => read(config, key);
      try {
        if (view !== undefined) {
          // keyed：轮转候选 key；`unusable` = 本后端没给出可用内容，换下一个后端、不惩罚 key。
          let escalated = false;
          let lastError;
          for (const candidate of view.candidates) {
            try {
              const outcome = await backend.run({
                apiKey: candidate.value,
                ctx,
                request,
                signal,
                budgetMs: budget,
                read: readValue,
                maxBodyChars,
              });
              if (outcome.kind === 'unusable') {
                failures.push({ backend: id, message: outcome.reason });
                escalated = true;
                break;
              }
              view.ring.advance(candidate.ref);
              return outcome.result;
            } catch (error) {
              if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
              view.ring.penalize(candidate.ref, error);
              lastError = error;
            }
          }
          if ((!escalated || backend.keepLastErrorOnUnusable === true) && lastError !== undefined) {
            failures.push({ backend: id, message: lastError instanceof Error ? lastError.message : String(lastError) });
          }
          continue;
        }

        // keyless（本地 http）：单次调用。
        const outcome = await backend.run({ ctx, request, signal, budgetMs: budget, read: readValue, maxBodyChars });
        return outcome.result;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
        failures.push({ backend: id, message: error instanceof Error ? error.message : String(error) });
        continue;
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
