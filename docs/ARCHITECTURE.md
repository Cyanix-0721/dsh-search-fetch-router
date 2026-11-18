# 架构：一张 `providerOrder` 驱动两条链

先记住一句话：**这个插件只做「路由」，不重新实现任何一种抓取能力。**
它把 `web_search` 与 `web_fetch` 两个宿主能力，分发给一组供应商（Tavily / Exa / Firecrawl），
外加两个「宿主本来就有」的兜底（官方 DeepSeek 搜索、本地 HTTP 抓取）。

**边界**：整站爬、反爬、结构化抽取这些高级抓取**不在本插件**，仍归 firecrawl MCP。
本插件的抓取只做「给一个 URL，取回它的正文」。

## 心智模型

```
                     ┌─────────────────────────────────────────────┐
   设置里的一张表      │  providerOrder = [tavily, exa, firecrawl]     │
   （也是启用开关）    │  顺序 = 尝试顺序；停用某家 = 从表里删掉它      │
                     └───────────────┬─────────────┬───────────────┘
                                     │             │
                        web_search   │             │   web_fetch
                                     ▼             ▼
                     ┌──────────────────┐   ┌──────────────────┐
                     │ 搜索链            │   │ 抓取链            │
                     │ 逐家试 search      │   │ 逐家试 fetch      │
                     └────────┬─────────┘   └────────┬─────────┘
                              │ 全部失败              │ 全部没拿到内容
                              ▼                      ▼
                    official 兜底(可选)        本地 http 兜底(可选)
                    searchFallback=true        fetchFallback=true
```

- **一张表，两条链**：`providerOrder` 同时决定搜索和抓取的顺序。停用一家，两条链都不用它。
- **每家供应商都有两个能力**：`search` 和 `fetch`。缺哪项就跳过哪条链（内置三家都齐全）。
- **兜底不是供应商**：`deepseek-official`（搜索）和本地 `http`（抓取）没有 key、不进表，
  只在「表里的供应商全失败」后、且对应 `*Fallback` 打开时兜底。

## 一次请求的数据流

以 `web_search` 为例（`web_fetch` 结构完全对称）：

0. **入参校验（触网前）**：空/全空白 query 抛 `WEB_INVALID_QUERY`；fetch 的 url 非法或
   `request` 整体缺失抛 `WEB_INVALID_URL`。宿主工具层通常已先挡一遍，这里是 provider 边界
   上对「直接调 `ctx.web.search`」的调用方的第二道闸——不白烧一次上游额度。
1. **读顺序**：`enabledProviderOrder(config)` —— `enabled`（总开关，输入框左侧按钮控制）为
   `false` 时直接返回空数组，于是两条链都只剩官方 / 本地兜底（旁路，第三方 key 不调用，
   配置保留）；否则读 `providerOrder`（搜索与抓取唯一一份）。
   随后 `warnUnknownProviders()` 把表里未注册的 id 打一行 `warn` 后跳过（正常 UI 产生不了，
   只有手改配置才会；不硬报错是因为 Config 抛错会连累两条被 pin 的链一起挂）。
   搜索还会用 `requestForBackend()` 按 `maxResultsMode` 决定条数：`cap` 夹到 `maxSearchResults` 上限；
   `provider-max` 用各家硬上限（`backend.maxResults`）；`provider-default` 不传条数、用各家默认。
2. **准备就绪（先解析 key，再决策）**：`prepareReadiness()` 对表里每个已注册供应商建一条视图：
   - **keyed**（有 key 池）：把配置里的「引用名数组」解析成候选 key（凭据服务 → 环境层），
     顺手记录本次该从第几把 key 领起（`KeyRing#claim()`，并发下分摊 key）。
   - **keyless**（宿主能力）：问 `isAvailable(ctx)`。
   可用性 = keyed 看「候选 key 是否 ≥1」，keyless 看 `isAvailable`。
   **这一步必须先于决策**：默认引用名永远存在，用「ref 名个数」判可用会恒真，
   于是「一个 key 都没填」被误当成「有 Tavily」，最后报一串看不懂的后端失败。
3. **排链**：`planSearchChain()` 按 `providerOrder` 顺序，跳过不可用、去重，末尾按需追加兜底。
4. **逐家尝试**（由 `lib/execute.js` 驱动，**没有 `if (backend === ...)`**）：
   - keyed：在本家候选 key 上轮转；成功 `advance`，key 级失败 `penalize` 并换下一把；
     每把 key 前重算剩余预算（段预算是「每把的上限」，不是共享的一份）。
   - keyless：单次调用，用剩余预算封顶。
   - 成功即返回；全失败则汇总成一行 `summary` 抛出。
5. **收尾判定**：`summarizeFailures()` 决定抛 `*_BUDGET_EXHAUSTED`（全被预算跳过）还是
   `*_ALL_FAILED`（真的都失败了）。错误码是外部契约，两条链必须同口径。

## 关键概念

| 概念 | 在哪 | 含义 |
| --- | --- | --- |
| 注册表 | `lib/search-backends.js`、`lib/fetch-backends.js` | 供应商 → 适配器的声明式表，加供应商不用改执行层 |
| keyed / keyless | 适配器的 `keyRefsField` 是否为 `null` | keyed 有 key 池（轮转/冷却/失效跳过）；keyless 只有 `isAvailable` |
| `unusable` | 适配器 `run` 的返回 | 「这次没拿出可用内容」（空正文/抓不到），换下一家，**不罚 key** |
| `requestLevel` | `lib/rest.js` 的 `requestFailure` | 上游 200 但响应体是错误：请求级失败，**不罚 key** |
| `errorPayload` | `lib/rest.js` | 识别「HTTP 200 但响应体其实是错误」，转成 `requestLevel` 失败，而不是静默返回空结果 |
| 结果条数上限 | `lib/config.js` 的 `maxSearchResults` | 统一各家默认条数：请求给更小的尊重更小，给更大的按上限截断（`maxResultsMode=cap` 时生效） |
| 条数取值方式 | `lib/config.js` 的 `maxResultsMode` | `cap` 统一上限 / `provider-max` 各家硬上限 / `provider-default` 各家默认 |
| 未知供应商 id | `lib/execute.js` 的 `warnUnknownProviders` | `providerOrder` 里未注册的 id 打 `warn` 后跳过（UI 产生不了，仅手改配置会遇到） |
| 超时冷却 | `lib/keyring.js` | 「慢」不是「坏」：超时按 1/5 冷却（下限 1s），不吃 `Retry-After` 放大 |
| 额度冷却 | `lib/keyring.js` | 432/433 类额度耗尽按更长冷却，且不判 key 永久失效 |
| 预算切片 | `lib/router.js` 的 `segmentTimeout` | 总预算是硬上限，单段是上限；剩余不足 `MIN_SEGMENT_BUDGET_MS` 就不再开新段 |
| 公共 POST | `lib/rest.js` 的 `postJson` | 组合超时、包错误体、挂 `status`/`Retry-After`、**取消原样透传** |

## 文件地图与加供应商

- **每个文件干什么、目录结构**：见 `AGENTS.md` 的「目录」。那里跟着改动同步更新，这里不再复制一份（复制就会过时）。
- **加一个供应商要改哪几处**：见 `AGENTS.md` 的「改代码时」——注册表 + `lib/config.js` 字段 + `lib/client.js` 的 `SEARCH_PROVIDERS` 镜像（这一处最容易漏）。`lib/execute.js` 与 `lib/router.js` 是数据驱动的，一行都不用改。

## 不变量

硬约束（踩过坑、别退回去）以 `AGENTS.md` 的「硬约束」为**唯一权威来源**，这里不再重复维护（连条数都别在这里写，写死就会漂）。
改代码前先读那一份——`README.md` 面向用户，`AGENTS.md` 面向改代码的人，架构叙述看本文。

## 测试与覆盖

`npm test`（`node --test`，无框架）覆盖：纯决策、三家映射、key 池、注册表契约、执行层降级、
HTTP 兜底真实成功路径、client 排序/停用、以及「README 设置表 ↔ config 字段」的一致性断言。
`node --experimental-test-coverage --test` 看覆盖率；`lib/search-backends.js` 官方 `isAvailable`
的 `catch` 是纯防御分支（构造 + `available()` 目前不会抛），是唯一非 100% 的位置。
