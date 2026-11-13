/**
 * 配置 schema。
 *
 * 每个字段都带 `.default(...)` + `.description(...)` + `.volatile()`。**只有
 * `.volatile()` 字段进设置表单**——一个 volatile 都没有的条目根本不会出现在
 * `settings.describe()` 里，用户也就看不到任何可改项。
 *
 * 这里**没有任何密钥字段**。密钥只以「ref 名」的形式出现（`tavilyApiKeyRefs`
 * 等），值由 DSH credentials 服务解析，落盘位置是 `~/.dsh/.credentials.yaml`
 * 或环境层，永远不进 `cordis.patch.yml`。
 *
 * @module dsh-search-fetch-router/config
 */

import z from '@deepseek-ai/schemastery';

/** 单把 key 冷却多久（毫秒）。 */
const DEFAULT_COOLDOWN_MS = 60_000;
/** 整条抓取链的总预算（毫秒）。必须小于 `tool-web.fetchTimeoutMs`（patch 里设 60000）。 */
const DEFAULT_TOTAL_BUDGET_MS = 45_000;
/** 整条搜索链的总预算（毫秒）。必须小于 `tool-web.searchTimeoutMs`（patch 里设 60000）。 */
const DEFAULT_SEARCH_TOTAL_BUDGET_MS = 30_000;
/** 单段预算。三段之和大于总预算是有意的：总预算是硬上限，单段只是上限。 */
const DEFAULT_TAVILY_TIMEOUT_MS = 15_000;
const DEFAULT_FIRECRAWL_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
/** 交给 `web_fetch` 的正文上限（字符）。 */
const DEFAULT_MAX_BODY_CHARS = 100_000;
/** 剩余预算低于此值就不再开新段（毫秒）。 */
export const MIN_SEGMENT_BUDGET_MS = 2_000;

/** Firecrawl 的 `maxAge` 默认两天，命中缓存不重新抓。 */
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;

// 供应商默认顺序，也是 searchProviderOrder→providerOrder 迁移比较用的基准。
export const DEFAULT_PROVIDER_ORDER = ['tavily', 'exa', 'firecrawl'];

export const Config = z.object({
  tavilyApiKeyRefs: z
    .array(z.string())
    .default(['TAVILY_API_KEY'])
    .description(
      'Tavily API key 的 credentials 引用名，按顺序轮转。引用名不是密钥本身：'
        + '值存放在 DSH credentials（~/.dsh/.credentials.yaml，0600）或环境变量里。'
        + '多把 key 时每行一个，如 TAVILY_API_KEY_1、TAVILY_API_KEY_2。',
    )
    .volatile(),

  exaApiKeyRefs: z
    .array(z.string())
    .default(['EXA_API_KEY'])
    .description(
      'Exa Search API key 的 credentials 引用名，按顺序轮转。同上，只存引用名，值在 DSH '
        + 'credentials 或环境变量里。多把 key 时每行一个，如 EXA_API_KEY_1、EXA_API_KEY_2。'
        + 'Exa 同时用于搜索（/search）与抓取（/contents）。',
    )
    .volatile(),

  keyNotes: z
    .dict(z.string())
    .default({})
    .description(
      '每把 key 的本机备注（键是引用名，值是一句话），方便分辨不同账号。只做展示，不参与请求。'
        + '在插件页的密钥卡片里填写。',
    )
    .volatile(),

  firecrawlApiKeyRefs: z
    .array(z.string())
    .default(['FIRECRAWL_API_KEY'])
    .description('Firecrawl API key 的 credentials 引用名，按顺序轮转。同上，只存引用名。')
    .volatile(),

  tavilyExtractDepth: z
    .union(['basic', 'advanced'])
    .default('basic')
    .description('Tavily /extract 的抽取深度。advanced 更贵也更慢，正文更全。')
    .volatile(),

  minContentChars: z
    .number()
    .default(0)
    .description(
      '仅对 Tavily 生效：抽出的正文短于此长度就换下一个抓取供应商。0 表示只看「空内容」与'
        + '「failed_results 非空」，不做长度判定；Exa / Firecrawl 只按空正文判断，不受此值影响。',
    )
    .volatile(),

  totalBudgetMs: z
    .number()
    .default(DEFAULT_TOTAL_BUDGET_MS)
    .description('一次 web_fetch 走完整条链的总预算（毫秒）。须小于 tool-web 的 fetchTimeoutMs。')
    .volatile(),

  tavilyTimeoutMs: z.number().default(DEFAULT_TAVILY_TIMEOUT_MS).description('Tavily 单段超时（毫秒）。').volatile(),

  exaTimeoutMs: z.number().default(DEFAULT_TAVILY_TIMEOUT_MS).description('Exa 单段超时（毫秒）。').volatile(),

  firecrawlTimeoutMs: z
    .number()
    .default(DEFAULT_FIRECRAWL_TIMEOUT_MS)
    .description('Firecrawl 单段超时（毫秒）。')
    .volatile(),

  httpTimeoutMs: z
    .number()
    .default(DEFAULT_HTTP_TIMEOUT_MS)
    .description('本地 HTTP 回落单段超时（毫秒）。')
    .volatile(),

  maxBodyChars: z.number().default(DEFAULT_MAX_BODY_CHARS).description('返回正文的字符上限，超出置 truncated。').volatile(),

  cooldownMs: z.number().default(DEFAULT_COOLDOWN_MS).description('一把 key 失败后冷却多久（毫秒）。').volatile(),

  providerOrder: z
    .array(z.string())
    .default([...DEFAULT_PROVIDER_ORDER])
    .description(
      '供应商的尝试顺序，也是启用顺序——搜索和抓取共用这一张表。默认 ["tavily", "exa", "firecrawl"]：'
        + '按顺序尝试，没配 key 的供应商在运行时会被跳过（哪家填了 key，哪家就自动生效）；'
        + '搜索全部失败后看 searchFallback 是否回落官方，抓取全部失败后看 fetchFallback 是否回落本地 http。'
        + '插件页里的排序 / 拖拽 / 停用改的就是这个列表。',
    )
    .volatile(),

  // 旧版字段：迁移用。旧版只有一个 searchProviderOrder，现在统一成 providerOrder。
  // 刻意不加 .volatile()——不显示在设置表单，只被 execute 读取后并入有效顺序。
  searchProviderOrder: z
    .array(z.string())
    .description('已废弃，请改用 providerOrder。仅用于从旧配置迁移搜索顺序，不在设置表单显示。'),

  searchTotalBudgetMs: z
    .number()
    .default(DEFAULT_SEARCH_TOTAL_BUDGET_MS)
    .description('一次 web_search 走完整条搜索链的总预算（毫秒）。须小于 tool-web 的 searchTimeoutMs。')
    .volatile(),

  verboseLog: z
    .boolean()
    .default(false)
    .description('日志级别：true 时执行层用 info 记录每次命中的供应商（不开 debug 也能在日志里看到）；false 时用 debug。')
    .volatile(),

  searchFallback: z
    .boolean()
    .default(true)
    .description('providerOrder 里的搜索供应商全部失败后是否回落 DSH 官方搜索（deepseek-official）。关掉则直接报错。')
    .volatile(),

  fetchFallback: z
    .boolean()
    .default(true)
    .description('providerOrder 里的抓取供应商都没拿到内容时是否回落本地 HTTP 抓取。关掉则直接报错。')
    .volatile(),

  firecrawlOnlyMainContent: z.boolean().default(true).description('Firecrawl 是否只取正文，丢掉导航与页脚。').volatile(),

  firecrawlMaxAgeMs: z
    .number()
    .default(DEFAULT_FIRECRAWL_MAX_AGE_MS)
    .description('Firecrawl 缓存有效期（毫秒），默认两天。0 表示每次都重新抓。')
    .volatile(),
});
