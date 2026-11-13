# Changelog

本文件记录本插件的可见变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划

- 收集 `0.1.0-alpha.0` 的反馈，稳定后发布 `0.1.0`。

### Added

- `exaSearchType` 配置项：Exa 搜索档位可选 `instant` / `fast` / `auto` / `deep-lite` / `deep` /
  `deep-reasoning`（默认 `auto`）。档位直接影响价格与延迟，此前写死 `auto`。非法值按 `auto`
  处理，不会把未知档位发给上游（上游对未知 `type` 返回 400，会让整次搜索失败）。
- 执行层把 `read` 传给搜索后端，后端可从配置读自己的调参项，不必为每个参数加一条
  `if (backend === ...)` 分支。
### Changed

- 凭据解析改为并行：每个 key 池内部并行解析、各后端之间也并行准备，不再把 N 把 key 的
  解析延迟叠加成 N 倍；结果仍按配置顺序回填，轮转次序不变。
- 命中日志追加本次耗时（`... in <n>ms`），排查「哪个后端慢」不用再靠掐表。
- 搜索与抓取共用的可用性判据（`makeAvailability`）抽成一处，避免两条链判据漂移；抓取每段
  的超时上限只读一次配置。
- 「API 密钥」卡片：每把 key 的**备注输入框与 key 输入框并到同一行**，不再单独占一行；
  「添加账号」按钮改为「＋ 再加一把 key」，并在旁边注明「同一供应商的第二把 key，请求
  轮流使用」——原按钮文案看不出它加的是同一家供应商的 key，而不是新增一家供应商。
### Fixed

- 「HTTP 200 但响应体其实是错误」不再被当成空结果静默吞掉：三家供应商正常报错都用
  4xx/5xx，但都出现过 200 + 错误体（Firecrawl 的 `{success:false,error}` 尤其常见）。
  各家搜索映射对「结果字段不是数组」一律回退成空数组，于是「上游出错」和「确实零结果」
  在调用方看来一模一样——用户拿到空结果，链也不会降级。现在 `lib/rest.js` 的
  `errorPayload()` 保守识别错误体（必须有错误字段且完全没有结果字段；`{results:[]}`
  仍是合法零结果），并打上 `requestLevel` 标记让 key 池不惩罚 key。
- Firecrawl 返回 200 但响应体缺 `data` 时不再惩罚整池 key：这是**请求级**的上游异常
  （反爬拦截等），此前抛 `TypeError` 被 keyed 循环当成「这把 key 坏了」，一次软错误就让
  该供应商所有 key 同时冷却、整条链不可用。现在按 `unusable` 换下一家，不罚 key。
- 并发请求不再共用同一个轮转起点：`resolvedCandidates()` 原先直接读共享的 `cursor`，
  两个并发请求都从第一把 key 开始，多 key 池在并发下退化成单 key（实测三个并发搜索全用
  K1），其余 key 形同虚设且更容易撞限流。现在每个请求用 `KeyRing#claim()` 领独立起点。
- 超时不再按整轮冷却惩罚 key：本地 `AbortSignal.timeout` / 上游 408、504 是「这次慢」，
  不是「这把 key 坏了」。此前一律按默认冷却（默认 60s），单 key 用户会因一次慢请求让唯一
  一把 key 停摆一个周期。现在走 1/5 冷却（下限 1s），且即使上游给了 `Retry-After` 也不放大。
- key 轮转不再穿透总预算：段预算（`tavilyTimeoutMs` 这类）是「每把 key 的上限」，
  但循环里照抄了外层预算，池里 N 把 key 会各吃满一次，总耗时变成 N×段预算。实测 3 把 key、
  段 2s、总预算 3s 跑了 6.01s，且最终错报成「三家都挂了」而不是「预算耗尽」。
- 抓取的 keyless 后端也会问 `isAvailable()`，与搜索对齐：此前对无 key 后端一律当作可用，
  一个自报不可用的后端仍会被调用，拿到的失败和「它本来就没准备好」是两回事。
- keyless 抓取后端返回 `unusable` 时换下一家，而不是把 `undefined` 当结果返回给工具层：
  此前那条路径会把 undefined 一路带出去，最后在更远处炸，错误信息对不上真正原因。
- 显式清空的 `providerOrder` 不再被旧字段 `searchProviderOrder` 复活：空数组只可能是用户
  主动全部停用（schema 默认是三家），此前重启后旧字段又把顺序救回来。
- Exa `/contents` 的失败原因按 `url` 匹配 `statuses`：上游按请求里的 urls 回填，别人的失败
  条目可能排在前面，按位置取会把无关的失败安到本次请求头上。
- Exa 抓取失败时把上游原因带进报错：`/contents` 抓不到页面时可能整体返回 200，只把该 URL
  放进 `statuses` 并给 `error.tag`。此前只看 `results[0].text`，于是「抓不到」和「页面是空的」
  都报成同一句 `Exa returned an empty body`，无从排查。
- Exa `/contents` 请求体带 `livecrawlTimeout`（夹在 90000ms 内）：此前只有本地 AbortSignal，
  我们断连后服务端仍在爬，那次调用照样计费。Firecrawl 搜索此前已做同样处理。
- Firecrawl 搜索的 snippet 优先取 `highlights`（与查询相关的片段）：此前优先 `description`，
  而 `description` 只在 `highlights:false` 时才有，默认响应下等于丢掉了最贴题的那段。
- Firecrawl 搜索兼容 `data` 直接是数组的响应形态（文档同时存在 `data.web` 与 `data` 两种）。
- Firecrawl 抓取失败时把上游原因带进报错：抓取被拦/超时时它仍可能返回 200，把原因写在
  `data.metadata.error` 或 `data.warning` 里。此前只报 `Firecrawl returned an empty body`，
  与「页面确实为空」无法区分。
- Firecrawl `/v2/scrape` 的 `timeout` 夹进文档要求的 1000–300000 范围：段预算可能远小于
  1000ms，越界会被上游以 400 拒绝，整段抓取白跑。
- Firecrawl 搜索的 `timeout` 同样夹进 1000–300000：此前直接透传段预算，段预算只剩几百
  毫秒时发出去的是非法值，上游回 400，看起来像「Firecrawl 挂了」，其实是自己发的坏请求。
- 跨域重定向不再让整次抓取失败：宿主 `HttpFetchProvider` 只跟同源重定向，`docs.x.com` 跳到
  `x.com` 这类常见跳转会被判 `WEB_REDIRECT_BLOCKED`。现在本地 http 兜底会显式跟着跳，最多
  三跳，并记录已访问 URL 以免成环；每一跳仍走宿主自己的 `fetch`，URL 安全校验不被绕过。
- 调用方取消不再被当成后端失败：`postJson` 原先把 `AbortError` 包成普通 `Error`，上层靠
  `error.name` 判断「是不是用户取消」，包装后认不出，于是取消会被记为一次后端失败并惩罚
  key、继续往下一家打。现在取消原样抛。
- `User-Agent` 的版本号与 `package.json` 对齐（此前停在 `0.1.0`，实际已是 `0.1.0-alpha.0`），
  并集中到 `lib/rest.js` 一处定义，由测试比对 `package.json` 守住。
- `tavilyExtractDepth` 改为 `z.string()` + 读取时规整（`normalizeExtractDepth`），不再用枚举：
  枚举会让一个拼错的值在 schema 校验阶段抛错，而 Config 抛错会连带整个插件加载失败——搜索与
  抓取两条链都被 pin 到本插件，等于把 `web_search`/`web_fetch` 一起弄挂。坏值现在按 `basic`
  处理，大小写不敏感。
- `exaSearchType` 的规整同样大小写不敏感（`Auto` / ` AUTO ` 都按 `auto`），此前只 trim。
- 客户端卡片「默认供应商顺序」改为从供应商表派生：此前另有一份手写字面量，加供应商时漏改
  会出现「卡片认这家、兜底顺序不认」的错位。
- Tavily `/extract` 请求体带服务端 `timeout`（秒，夹在官方 1–60 内）：此前只有本地 AbortSignal，
  我们断连后服务端仍会把抽取跑完，那次调用照样计费。
- Tavily 的 429 现在会读 `Retry-After` 头：不同限流规则的等待时长不同，用固定冷却不是太久就是太短。
- Tavily 的 432 / 433（key 限额、套餐限额、PayGo 限额）单独归类为「额度耗尽」，冷却放大 60×
  且不把 key 标成永久失效：此前它们和普通失败一样只冷却 1×，整条链会每隔一分钟去撞一次注定
  失败的请求。
- Tavily `/search` 的 `max_results` 夹进官方范围 0–20：工具层给的条数可能更大，越界会被上游
  以 400 拒绝，整次搜索直接失败。

## [0.1.0-alpha.0] - 2026-11-13

首个可用版本。

### 新增

- 声明式搜索与抓取路由：一张 `providerOrder`（默认 `tavily → exa → firecrawl`）同时驱动搜索与抓取，
  每家供应商按它实现的能力进入对应链路，停用一家则两条链都不用它。
- 内置供应商：Tavily（`/search` + `/extract`）、Exa（`/search` + `/contents`）、Firecrawl（`/v2/search` + `/v2/scrape`）。
- 无 key 兜底：搜索回落宿主 `deepseek-official`，抓取回落本地 `http`，分别由 `searchFallback` / `fetchFallback` 开关。
- Key 池：按 ref 名轮转、失败冷却、永久失效跳过，状态跨调用存活。
- 抓取总预算 `totalBudgetMs`（默认 45s）与搜索总预算 `searchTotalBudgetMs`（默认 30s）；预算耗尽分别抛
  `WEB_FETCH_BUDGET_EXHAUSTED` / `WEB_SEARCH_BUDGET_EXHAUSTED`。
- 插件页密钥卡片：按 `providerOrder` 排序（拖拽或上下箭头）、启用/停用、每把 key 备注、已存 key 的掩码预览。
- 执行层 debug 日志（`note()`），记录每次请求实际由哪个供应商服务。
- GitHub Actions CI：node 22 / 24 矩阵跑 `npm test`。

### 说明

- 密钥永不进 YAML：配置只存 credentials 引用名，值经 DSH credentials 服务或环境变量解析。
- 边界：整站爬、反爬、结构化抽取、批量任务不归本插件，交给 firecrawl MCP；本插件只做单 URL 的 `web_fetch`。
