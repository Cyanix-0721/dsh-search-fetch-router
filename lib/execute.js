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
 * 读有效供应商顺序。
 *
 * 直接取 `providerOrder`——这是唯一一份顺序（搜索与抓取共用）。空数组表示用户把供应商
 * 全部停用，是合法值，不是「没配过」。
 * @param config - 插件配置。
 * @returns 供应商 id 数组，可能为空（全部停用）。
 */
/**
 * 优先级最高的「总开关」：`enabled === false` 时返回空顺序，使两条链都只剩兜底
 * （搜索→官方 deepseek，抓取→本地 http），第三方供应商一概不碰。配置本身不动。
 * @param config - 本插件配置。
 * @returns providerOrder，或关闭时为空数组。
 */
function enabledProviderOrder(config) {
  return read(config, 'enabled') === false ? [] : resolveProviderOrder(config);
}

function resolveProviderOrder(config) {
  return readStrings(config, 'providerOrder');
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
 * 记一条「配置有问题」的告警。
 *
 * 用 `warn` 而不是 `note` 的 debug：`providerOrder` 里写了未注册的供应商 id 是配置错误，
 * 用户不会主动开 verboseLog，静默跳过会让人以为那家生效了。logger 没有 warn 就退到
 * info/debug；logger 抛错也绝不能毁掉请求。
 * @param ctx - 插件上下文。
 * @param message - 告警文本。
 */
function warnConfig(ctx, message) {
  const text = `dsh-search-fetch-router: ${message}`;
  try {
    (ctx?.logger?.warn ?? ctx?.logger?.info ?? ctx?.logger?.debug)?.(text);
  } catch {
    // 见上：记日志不是关键路径
  }
}

/**
 * 报告 `providerOrder` 里未注册（拼错或旧名）的供应商 id。
 *
 * 执行层对未知 id 一律跳过（不能因为一个拼错就崩掉整条链），但**静默**跳过是陷阱：
 * 用户改完顺序发现某家「没生效」，却没有一行日志可查。这里给 warn 补上可见性。
 * @param ctx - 插件上下文。
 * @param chain - `'search'` 或 `'fetch'`，只用于文案区分。
 * @param order - 用户配置的供应商顺序。
 * @param lookup - 该链的注册表查询。
 * @param fallbackId - 兜底后端 id（它在注册表里，但可能不在 order 里，不该被报）。
 */
function warnUnknownProviders(ctx, chain, order, lookup, fallbackId) {
  const unknown = order.filter((id) => typeof id === 'string' && id !== fallbackId && lookup(id) === undefined);
  if (unknown.length === 0) return;
  warnConfig(ctx, `providerOrder 里有未注册的 ${chain} 供应商 id，已跳过: ${unknown.join(', ')}`);
}

/**
 * 把请求的结果条数夹到统一上限。
 *
 * 各家默认条数不一致（Tavily 默认更少），同一次检索由不同供应商服务会拿到不同数量。
 * 这里统一兜底：没给就用上限，给了更小的尊重更小的，给了更大的按上限截断。各家仍有自己的
 * 硬上限（如 Tavily 20），适配器会再夹一次。
 * @param request - `WebSearchRequest`。
 * @param cap - 统一上限（`maxSearchResults`）。
 * @returns 可能的浅拷贝；`maxResults` 未变时原样返回。
 */
function withMaxResults(request, cap) {
  if (request === undefined || request === null) return request;
  const wanted = Number.isInteger(request.maxResults) && request.maxResults > 0 ? request.maxResults : cap;
  const capped = Math.min(wanted, cap);
  if (request.maxResults === capped) return request;
  return { ...request, maxResults: capped };
}

/**
 * 为某个具体供应商算出这次请求该带多少 maxResults。
 *
 * 三种模式（`maxResultsMode`）：
 * - `cap`（默认）：统一上限 `maxSearchResults`——没给用上限，给了更小尊重更小的，更大按上限截断。
 * - `provider-max`：绕过统一上限，按该供应商自己的硬上限下发（`backend.maxResults`）。
 * - `provider-default`：连 maxResults 都不传，让各家用自己的默认值。
 * 没有自带硬上限的后端（官方）在 `provider-max` 下原样传请求。
 * @param request - `WebSearchRequest`。
 * @param backend - 当前要打的搜索后端。
 * @param config - 插件配置。
 * @returns `WebSearchRequest`（可能浅拷贝）。
 */
const MAX_RESULTS_MODES = new Set(['cap', 'provider-max', 'provider-default']);

/** 规整 `maxResultsMode`：只认三个白名单值，其余（含拼错、大小写、两端空白）按 cap。 */
function normalizeMaxResultsMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return MAX_RESULTS_MODES.has(mode) ? mode : 'cap';
}

function requestForBackend(request, backend, config) {
  if (request === undefined || request === null) return request;
  const mode = normalizeMaxResultsMode(read(config, 'maxResultsMode'));
  if (mode === 'provider-max') {
    return Number.isInteger(backend?.maxResults) ? { ...request, maxResults: backend.maxResults } : request;
  }
  if (mode === 'provider-default') {
    if (request.maxResults === undefined) return request;
    const { maxResults: _dropped, ...rest } = request;
    return rest;
  }
  return withMaxResults(request, readNumber(config, 'maxSearchResults', 20));
}

/**
 * 把一条链上累积的失败汇总成统一口径。
 *
 * 搜索与抓取都需要「拼一行 summary、判断是不是全被预算跳过、取最后一条当 cause」，
 * 三件事必须同口径——否则「耗尽」与「全失败」会在两条链上被判定成不同情况，
 * 而它们对应的错误码（`*_BUDGET_EXHAUSTED` 与 `*_ALL_FAILED`）是给上层看的外部契约。
 * @param failures - `{backend, message}` 数组。
 * @returns `{summary, exhausted, last}`。
 */
function summarizeFailures(failures) {
  const summary = failures.map((item) => `${item.backend}: ${item.message}`).join('; ');
  const exhausted = failures.length > 0 && failures.every((item) => item.message.startsWith('skipped:'));
  const last = failures.length > 0 ? new Error(failures[failures.length - 1].message) : undefined;
  return { summary, exhausted, last };
}

/**
 * 建一条链的可用性判据：`id → 是否可用`。
 *
 * 搜索与抓取用它时逐字相同，抽出来免得两处漂——判据一旦不一致，同一家供应商可能在
 * 一条链上被跳过、另一条上却照打。keyed 看「解析出几把可用 key」，keyless 问后端自己
 * （`isAvailable` 可选，没实现就当永远可用）。
 * @param readiness - `prepareReadiness` 的视图 Map。
 * @param ctx - 插件上下文（keyless 的 `isAvailable(ctx)` 要用）。
 * @returns `(id) => boolean`。
 */
function makeAvailability(readiness, ctx) {
  return (id) => {
    const view = readiness.get(id);
    if (view === undefined) return false;
    const { backend, candidates } = view;
    if (backend.keyRefsField === null) {
      return typeof backend.isAvailable === 'function' ? backend.isAvailable(ctx) : true;
    }
    return candidates.length > 0;
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
 * 为一条链准备运行时视图：`id → {backend, ring, candidates}`。
 *
 * 搜索与抓取这段逻辑逐字相同（都是「按 order 找适配器、keyed 建池并预解析、keyless 标记
 * 为空、兜底单独准备」），所以放在一处。**先解析再决策**是这里的核心：ref 名存在不代表
 * 解析得到值，只按 ref 名判断可用性会恒真（默认 ref 名永远在配置里），最后报出一串看不懂
 * 的后端失败。
 *
 * @param order - 用户配置的供应商顺序。
 * @param fallbackId - 兜底后端 id（官方搜索 / 本地 http）。
 * @param lookup - `(id) => backend|undefined`，该链的注册表查询。
 * @param ringFor - `(id, keyRefsField) => KeyRing`。
 * @returns 视图 Map，按 order 顺序插入，兜底在末尾。
 */
async function prepareReadiness(order, fallbackId, lookup, ringFor) {
  const readiness = new Map();
  const prepare = (backend) => {
    if (backend.keyRefsField === null) {
      readiness.set(backend.id, { backend, ring: null, candidates: [] });
      return;
    }
    readiness.set(backend.id, {
      backend,
      ring: ringFor(backend.id, backend.keyRefsField),
      candidates: null, // 稍后异步解析再填
    });
  };
  for (const id of order) {
    const backend = lookup(id);
    if (backend !== undefined) prepare(backend);
  }
  const fallbackBackend = lookup(fallbackId);
  if (fallbackBackend !== undefined && !readiness.has(fallbackBackend.id)) prepare(fallbackBackend);

  // 各后端的 key 解析并行跑（每个池内部也已并行），别把一个 provider 的解析延迟叠到下一个上。
  // 每个请求领一个自己的起点：共用游标会让并发请求都从第一把 key 开始，多 key 池在并发下
  // 就退化成单 key（见 `KeyRing#claim`）。各后端各有自己的池，claim 互不干扰。
  await Promise.all(
    [...readiness.values()]
      .filter((view) => view.ring !== null)
      .map(async (view) => {
        view.candidates = await view.ring.resolvedCandidates(Date.now(), view.ring.claim());
      }),
  );
  return readiness;
}

/**
 * 建路由对象。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @param options - 仅测试用的注入点：`searchBackends` / `fetchBackends` 覆盖两张注册表。
 * @returns `{search, fetch}`，两个方法都返回 seam 期望的形状。
 */
export function createRouter(ctx, config, options = {}) {
  const resolveCredential = makeCredentialResolver(ctx);
  // 两张注册表都可注入——测试用它在不改生产代码的前提下验证「新增供应商即生效」。
  // 生产默认走各 registry 的 lookup*Backend（未知 id 返回 undefined，执行层跳过）。
  const lookupBackend = options.searchBackends === undefined
    ? lookupSearchBackend
    : (id) => options.searchBackends[id];
  const lookupFetch = options.fetchBackends === undefined
    ? lookupFetchBackend
    : (id) => options.fetchBackends[id];

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
    // 早期校验：空/空白/非字符串 query 直接给明确错误码，不必等到打上游再用一次额度换一个 400。
    // 宿主 `dsh-tool-web` 在工具层通常已挡掉空 query，这里是 provider 边界上的第二道闸——
    // 直接调 `ctx.web.search` 的调用方未必过工具层。
    const query = request?.query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw webError('web search needs a non-empty query', CODES.INVALID_QUERY);
    }
    const fallback = read(config, 'searchFallback') !== false;
    const fallbackId = SEARCH_BACKEND_IDS.official;
    // 总开关关闭时 order 为空 → 链上只剩官方兜底，第三方 key 一概不调用。
    const order = enabledProviderOrder(config);
    warnUnknownProviders(ctx, 'search', order, lookupBackend, fallbackId);
    // 结果条数按「统一上限 / 各供应商最大」二选一，在每次打后端时用 requestForBackend 现算。
    const searchTotalBudgetMs = readNumber(config, 'searchTotalBudgetMs', 30_000);
    const deadline = Date.now() + searchTotalBudgetMs;

    // 未知 id 忽略；官方兜底即使没写进 order 也准备好，供末尾兜底使用。
    const readiness = await prepareReadiness(order, fallbackId, lookupBackend, ringFor);

    const chain = planSearchChain({ order, isAvailable: makeAvailability(readiness, ctx), fallback, fallbackBackend: fallbackId });
    if (chain.length === 0) {
      throw webError(
        'no web search provider is usable: no configured key reference resolved for any provider '
          + 'in providerOrder and the official DeepSeek search provider is not configured either',
        CODES.SEARCH_ALL_FAILED,
      );
    }

    // 后端要读的配置项（如 Exa 的 exaSearchType）通过这个函数拿，保持 run 的签名统一。
    const readValue = (key) => read(config, key);
    const failures = [];
    for (const id of chain) {
      if (signal?.aborted === true) throw webError('web search aborted', CODES.ABORTED);
      const { backend, ring, candidates } = readiness.get(id);
      const attemptStart = Date.now();
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
            // 每把 key 都要重算剩余预算。段预算对同一后端的所有 key 是「每把的上限」，
            // 不是「所有 key 共享的一份」——照抄外层 budget 会让 N 把 key 各吃满一次，
            // 总耗时变成 N×段预算，把总预算彻底穿透（实测 3 把 key / 段 2s / 总 3s
            // 跑成了 6s，最后还错报成 ALL_FAILED 而非 BUDGET_EXHAUSTED）。
            const keyBudget = segmentTimeout({
              remainingMs: deadline - Date.now(),
              segmentMs,
              minSegmentMs: MIN_SEGMENT_BUDGET_MS,
            });
            if (keyBudget === null) break;
            try {
              const result = await backend.run({
                apiKey: candidate.value,
                ctx,
                request: requestForBackend(request, backend, config),
                signal,
                timeoutMs: keyBudget,
                read: readValue,
              });
              ring.advance(candidate.ref);
              note(ctx, config, `web_search served by ${id} (key ${candidate.ref}) in ${Date.now() - attemptStart}ms`);
              return result;
            } catch (error) {
              if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
              // `requestLevel` = 上游 200 但响应体是错误：请求本身有问题，不是这把 key 坏了。
              // 惩罚它会把整池 key 打进冷却，一次软错误就让该供应商停摆一个冷却周期。
              if (error?.requestLevel !== true) ring.penalize(candidate.ref, error);
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
        const result = await backend.run({
          ctx,
          request: requestForBackend(request, backend, config),
          signal: boundedSignal,
          read: readValue,
        });
        note(ctx, config, `web_search served by ${id} in ${Date.now() - attemptStart}ms`);
        return result;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
        failures.push({ backend: id, message: error instanceof Error ? error.message : String(error) });
      }
    }

    const { summary, exhausted, last } = summarizeFailures(failures);
    note(ctx, config, `web_search ${exhausted ? 'budget exhausted' : 'all backends failed'}: ${summary}`);
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
    // `request?.url`：连 request 本身缺失也要给 `WEB_INVALID_URL`，而不是裸 `TypeError`。
    assertFetchableUrl(request?.url, webError);

    const fallback = read(config, 'fetchFallback') !== false;
    const totalBudgetMs = readNumber(config, 'totalBudgetMs', 45_000);
    const deadline = Date.now() + totalBudgetMs;
    const maxBodyChars = readNumber(config, 'maxBodyChars', 100_000);

    // 抓取与搜索共用 providerOrder；没有抓取适配器的 id 会被 lookupFetch 过滤掉。
    const fallbackId = 'http';
    // 总开关关闭时 order 为空 → 链上只剩本地 http 兜底。
    const order = enabledProviderOrder(config);
    warnUnknownProviders(ctx, 'fetch', order, lookupFetch, fallbackId);
    const readiness = await prepareReadiness(order, fallbackId, lookupFetch, ringFor);

    // 与搜索同一套判据（共用 makeAvailability）：keyed 看「解析出几把可用 key」，
    // keyless 问后端自己。抓取目前只有 http 一个 keyless，但判据必须对称——否则以后
    // 加一个自建实例式的 keyless 抓取后端，会绕过可用性检查。
    const chain = planFetchChain({ order, isAvailable: makeAvailability(readiness, ctx), fallback, fallbackBackend: fallbackId });

    if (chain.length === 0) {
      throw webError(
        'no web fetch provider is usable: no configured key reference resolved for any provider '
          + 'in providerOrder and the local HTTP fallback is disabled',
        CODES.FETCH_ALL_FAILED,
      );
    }

    const failures = [];

    for (const id of chain) {
      if (signal?.aborted === true) throw webError('web fetch aborted', CODES.ABORTED);

      // 入链的 id 必然在 readiness 里（availability 要求 view 存在），不必再查一次表。
      const { backend, ring, candidates } = readiness.get(id);
      const attemptStart = Date.now();

      // 段上限只读一次，段预算和每把 key 的预算共用它（keyed 时是「每把 key 的上限」，
      // 不是整个后端共享的一份）。
      const segmentMs = readNumber(config, backend.timeoutField, backend.defaultTimeoutMs);
      const budget = segmentTimeout({
        remainingMs: deadline - Date.now(),
        segmentMs,
        minSegmentMs: MIN_SEGMENT_BUDGET_MS,
      });
      if (budget === null) {
        failures.push({ backend: id, message: 'skipped: fetch budget exhausted' });
        continue;
      }

      const readValue = (key) => read(config, key);
      try {
        if (ring !== null) {
          // keyed：轮转候选 key；`unusable` = 本后端没给出可用内容，换下一个后端、不惩罚 key。
          //
          // 遇到 `unusable` 直接 break，同后端其余 key 不再试——这是个**有意的假设**：
          // `unusable` 的定义是「后端对这次请求没给出可用内容」（空正文、上游说抓不到），
          // 与用哪把 key 无关，换 key 重试只会白花一次调用。反过来，key 级失败（401/429/
          // 额度耗尽）是抛错而不是 unusable，那种情况下面的 catch 会罚 key 并继续轮转。
          // 如果将来某个后端的「不可用」其实是 per-key 的（比如按 key 的套餐限制抓取域名），
          // 就必须把它改成抛错，否则这里会错误地放弃整个后端。
          let escalated = false;
          let lastError;
          for (const candidate of candidates) {
            // 与搜索同理：段预算是「每把 key 的上限」，不是整个后端共享的一份。
            const keyBudget = segmentTimeout({
              remainingMs: deadline - Date.now(),
              segmentMs,
              minSegmentMs: MIN_SEGMENT_BUDGET_MS,
            });
            if (keyBudget === null) break;
            try {
              const outcome = await backend.run({
                apiKey: candidate.value,
                ctx,
                request,
                signal,
                budgetMs: keyBudget,
                read: readValue,
                maxBodyChars,
              });
              if (outcome.kind === 'unusable') {
                failures.push({ backend: id, message: outcome.reason });
                escalated = true;
                break;
              }
              ring.advance(candidate.ref);
              note(ctx, config, `web_fetch served by ${id} (key ${candidate.ref}) in ${Date.now() - attemptStart}ms`);
              return outcome.result;
            } catch (error) {
              if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
              // 同搜索：`requestLevel` 是请求级失败，不该罚 key（见 lib/rest.js 的 requestFailure）。
              if (error?.requestLevel !== true) ring.penalize(candidate.ref, error);
              lastError = error;
            }
          }
          if ((!escalated || backend.keepLastErrorOnUnusable === true) && lastError !== undefined) {
            failures.push({ backend: id, message: lastError instanceof Error ? lastError.message : String(lastError) });
          }
          continue;
        }

        // keyless（本地 http）：单次调用。`unusable` 与 keyed 分支同样处理——换下一个
        // 后端，绝不能把 `outcome.result`（undefined）当成功结果返回给工具层。
        const outcome = await backend.run({ ctx, request, signal, budgetMs: budget, read: readValue, maxBodyChars });
        if (outcome.kind === 'unusable') {
          failures.push({ backend: id, message: outcome.reason });
          continue;
        }
        note(ctx, config, `web_fetch served by ${id} in ${Date.now() - attemptStart}ms`);
        return outcome.result;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw asWebError(error, CODES.ABORTED);
        failures.push({ backend: id, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    const { summary, exhausted, last } = summarizeFailures(failures);
    note(ctx, config, `web_fetch ${exhausted ? 'budget exhausted' : 'all backends failed'}: ${summary}`);
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
