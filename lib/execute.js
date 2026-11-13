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

import { DEFAULT_PROVIDER_ORDER, MIN_SEGMENT_BUDGET_MS } from './config.js';
import { asWebError, CODES, isAbortError, webError } from './errors.js';
import { lookupFetchBackend } from './fetch-backends.js';
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
 * 解析有效供应商顺序（迁移用）。
 *
 * 旧版只有 `searchProviderOrder`，现在统一成 `providerOrder`。若 `providerOrder` 还是默认值
 * （或为空）而旧字段有值，就沿用旧字段——升级后老用户已存的顺序不会丢；一旦用户在新字段里
 * 改过顺序（非默认），一律以新字段为准。
 * @param config - 插件配置。
 * @returns 供应商 id 数组。
 */
function resolveProviderOrder(config) {
  const order = readStrings(config, 'providerOrder');
  const legacy = readStrings(config, 'searchProviderOrder');
  if (legacy.length === 0) return order;
  if (order.length === 0) return legacy;
  const isDefault = order.length === DEFAULT_PROVIDER_ORDER.length
    && order.every((id, index) => id === DEFAULT_PROVIDER_ORDER[index]);
  return isDefault ? legacy : order;
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
 * 记下「哪个后端服务了本次请求」——排查路由走向时唯一不靠猜的入口。
 *
 * 默认用 debug 级别（不刷屏）；把配置 `verboseLog` 打开则升到 info，正常日志里也能看到命中。
 * 日志绝不该影响请求本身，因此整体吞异常；宿主没挂 logger 时静默跳过。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @param message - 日志文本。
 */
function note(ctx, config, message) {
  const text = `dsh-search-fetch-router: ${message}`;
  const logger = ctx?.logger;
  try {
    if (read(config, 'verboseLog') === true) {
      (logger?.info ?? logger?.debug)?.(text);
    } else {
      logger?.debug?.(text);
    }
  } catch {
    // 记日志失败无所谓，不能因此毁掉请求
  }
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
    const order = resolveProviderOrder(config);
    const searchTotalBudgetMs = readNumber(config, 'searchTotalBudgetMs', 30_000);
    const deadline = Date.now() + searchTotalBudgetMs;

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

    // 后端要读的配置项（如 Exa 的 exaSearchType）通过这个函数拿，保持 run 的签名统一。
    const readValue = (key) => read(config, key);
    const failures = [];
    for (const id of chain) {
      if (signal?.aborted === true) throw webError('web search aborted', CODES.ABORTED);
      const { backend, ring, candidates } = readiness.get(id);
      // 总预算硬上限：keyed 用配置的单段超时，keyless（官方）把剩余预算整段给它；
      // 剩余不足 MIN_SEGMENT_BUDGET_MS 就跳过此后端，绝不发起注定超时的请求。
      const segmentMs = backend.keyRefsField === null
        ? Number.POSITIVE_INFINITY
        : readNumber(config, backend.timeoutField, backend.defaultTimeoutMs);
      const budget = segmentTimeout({
        remainingMs: deadline - Date.now(),
        segmentMs,
        minSegmentMs: MIN_SEGMENT_BUDGET_MS,
      });
      if (budget === null) {
        failures.push({ backend: id, message: 'skipped: search budget exhausted' });
        continue;
      }
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
                timeoutMs: budget,
                read: readValue,
              });
              ring.advance(candidate.ref);
              note(ctx, config, `web_search served by ${id} (key ${candidate.ref})`);
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
        // keyless：单次调用，用剩余预算封顶。
        const boundedSignal = signal === undefined
          ? AbortSignal.timeout(budget)
          : AbortSignal.any([signal, AbortSignal.timeout(budget)]);
        const result = await backend.run({ ctx, request, signal: boundedSignal, read: readValue });
        note(ctx, config, `web_search served by ${id}`);
        return result;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
        failures.push({ backend: id, message: error instanceof Error ? error.message : String(error) });
      }
    }

    const summary = failures.map((item) => `${item.backend}: ${item.message}`).join('; ');
    const exhausted = failures.length > 0 && failures.every((item) => item.message.startsWith('skipped:'));
    note(ctx, config, `web_search ${exhausted ? 'budget exhausted' : 'all backends failed'}: ${summary}`);
    const last = failures.length > 0 ? new Error(failures[failures.length - 1].message) : undefined;
    throw webError(
      exhausted
        ? `web search gave up after ${searchTotalBudgetMs}ms without completing a single backend (${summary})`
        : `every web search backend failed (${summary})`,
      exhausted ? CODES.SEARCH_BUDGET_EXHAUSTED : CODES.SEARCH_ALL_FAILED,
      last,
    );
  }

  /**
   * 抓取：按 providerOrder（与搜索共用）逐家尝试，末尾可回落本地 http。
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

    // 抓取与搜索共用 providerOrder。为 order 里每个「有抓取适配器」的供应商准备运行时视图；
    // http 作为无 key 兜底单独准备。先解析 key 再决策（ref 名常在，值未必有）。
    const order = resolveProviderOrder(config);
    const fallbackId = 'http';
    const readiness = new Map();
    const prepare = (backend) => {
      if (backend.keyRefsField === null) {
        readiness.set(backend.id, { backend, ring: null, candidates: [] });
      } else {
        readiness.set(backend.id, {
          backend,
          ring: ringFor(backend.id, backend.keyRefsField),
          candidates: null,
        });
      }
    };
    for (const id of order) {
      const backend = lookupFetchBackend(id);
      if (backend !== undefined) prepare(backend);
    }
    const httpBackend = lookupFetchBackend(fallbackId);
    if (httpBackend !== undefined && !readiness.has(httpBackend.id)) prepare(httpBackend);
    for (const view of readiness.values()) {
      if (view.ring !== null) view.candidates = await view.ring.resolvedCandidates();
    }

    const availability = (id) => {
      const view = readiness.get(id);
      if (view === undefined) return false;
      if (view.backend.keyRefsField === null) return true;
      return view.candidates.length > 0;
    };

    const chain = planFetchChain({ order, isAvailable: availability, fallback, fallbackBackend: fallbackId });

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
        if (view !== undefined && backend.keyRefsField !== null) {
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
              note(ctx, config, `web_fetch served by ${id} (key ${candidate.ref})`);
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
        note(ctx, config, `web_fetch served by ${id}`);
        return outcome.result;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
        failures.push({ backend: id, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    const summary = failures.map((item) => `${item.backend}: ${item.message}`).join('; ');
    const exhausted = failures.length > 0 && failures.every((item) => item.message.startsWith('skipped:'));
    note(ctx, config, `web_fetch ${exhausted ? 'budget exhausted' : 'all backends failed'}: ${summary}`);
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
