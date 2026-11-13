# dsh-search-fetch-router

[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件：接管 `web_search` 与
`web_fetch`，**Tavily 优先**，需要真实浏览器时升级到 **Firecrawl**，都不行再回落宿主
自己的提供方。

密钥不进任何配置文件。它们放在 DSH credentials 服务（或环境变量）里，插件手里只有
一个引用名。

## 路由

**搜索与抓取** —— 都按同一份 `providerOrder`（默认 `["tavily", "exa", "firecrawl"]`，没配 key 的供应商运行时自动跳过）。搜索在末尾追加宿主的 `deepseek-official` 兜底（受 `searchFallback` 控制）；抓取在末尾追加本地 `http` 兜底（受 `fetchFallback` 控制）。在插件页卡片上停用一家，**两条链都不用它**。卡片还可以拖拽或上下箭头排序、给每家写备注，并显示已保存 key 的掩码预览。

每家供应商按它实现了什么来决定用于搜索和/或抓取：

| 供应商 | 搜索 | 抓取 |
| --- | --- | --- |
| Tavily | `/search` | `/extract` |
| Exa | `/search` | `/contents` |
| Firecrawl | `/v2/search` | `/v2/scrape` |

抓取按顺序往下走，当前这家「没给出可用内容」就换下一家——报错、正文为空，或（Tavily）
`failed_results` 非空、正文短于 `minContentChars`。**刻意不做**「内容看起来不完整」这种猜测，
猜错就是白花额度。

再花哨的——整站爬、反爬、结构化抽取——不是本插件的活，走 firecrawl MCP。

每次抓取跑在一个硬预算下（`totalBudgetMs`，默认 45 秒）。每段拿
`min(自己的超时, 剩余预算)`；剩余不足 2 秒就不再开新段。

## 新增搜索供应商

搜索后端是**声明式注册**的，执行层没有任何针对具体供应商的分支。要加一个供应商，只动三处：

1. `lib/search-backends.js` 的 `SEARCH_BACKENDS` 里加一项：`id`、`label`、`keyRefsField`、
   `timeoutField`、`defaultTimeoutMs`、`run({apiKey, request, signal, timeoutMs})`。
   `run` 返回 seam 的 `WebSearchResult`。宿主自带、没有 key 池的能力把 `keyRefsField`
   设成 `null`，改为实现 `isAvailable(ctx)`。
2. `lib/config.js` 加该供应商的 key refs 数组字段与单次超时字段（都要 `.volatile()`）。
3. 用户把它的 `id` 填进 `providerOrder`。

有 key 池的供应商（`keyRefsField` 非空）自动获得轮转 / 冷却 / 失效跳过；无 key 的走
`isAvailable` 单次调用。`lib/execute.js` 与 `lib/router.js` 都不用改。测试见
`test/execute.test.js` 里「a newly registered backend is picked up …」——它用注入注册表
证明这一点。

客户端的「API 密钥」卡片由 `lib/client.js` 的供应商列表（`SEARCH_PROVIDERS`）渲染；
新增带 key 的供应商在那里加一项就会出现输入框（`run` 与配置字段可以先落地，卡片可以后补）。

## 新增抓取供应商

抓取后端同样是**声明式注册**的（`lib/fetch-backends.js`），并且与搜索**共用同一份
`providerOrder`**——没有单独的固定顺序。要加一个抓取供应商：

1. 在 `FETCH_BACKENDS` 里加一项：`id`、`label`、`keyRefsField`、`timeoutField`、
   `defaultTimeoutMs`、`run({apiKey, ctx, request, signal, budgetMs, read, maxBodyChars})`。
   `run` 返回 `{kind:'result', result}`（成功）或 `{kind:'unusable', reason}`（本后端没给出
   可用内容，换下一家、不惩罚 key）；抛错则视为 key 级失败、换下一把。
2. `lib/config.js` 加 key refs 数组与单次超时字段（都要 `.volatile()`）。
3. 如果它也要做搜索，在 `lib/search-backends.js` 用同一个 id 注册一个搜索适配器；否则只出现在抓取链里。
4. 用户把它的 id 填进 `providerOrder`。
5. 测试可用 `createRouter(ctx, config, {fetchBackends: {...}})` 注入注册表（与搜索侧的
   `searchBackends` 对称），不改生产代码即可验证「新增供应商即被采用」。

**边界**：整站爬、反爬、结构化抽取、批量任务**不属于本插件**，交给 firecrawl MCP。
本插件只是单 URL `web_fetch` 的一条路由。`lib/execute.js` 与 `lib/router.js` 都不用改。

## 安装

装进 DSH profile——从 npm（`dsh-search-fetch-router@alpha`）或直接从仓库：

```bash
npx --yes @deepseek-ai/dsh plugin --profile web add \
  github:Cyanix-0721/dsh-search-fetch-router
```

或者用本地检出：

```bash
npx --yes @deepseek-ai/dsh plugin --profile web add \
  /path/to/dsh-search-fetch-router
```

装完重启 DSH。bundle patch 会把插件挂上并 pin 住两个 provider。

## 密钥

插件读**引用名**，从不读值。两种填法，都在 YAML 之外：

```yaml
# 一、DSH credentials 存储 —— ~/.dsh/.credentials.yaml，0600，不进 git。
#     把名字加进已有的 refs: 映射里。
version: 1
refs:
  TAVILY_API_KEY: tvly-...
  FIRECRAWL_API_KEY: fc-...
records: {}
```

```bash
# 二、环境层 —— 进程环境，或 ~/.dsh/.env
export TAVILY_API_KEY=tvly-...
```

最省事的填法是用本插件在**插件页**加的那张「API 密钥」卡片——每个引用名一个密码框，
保存即写入 DSH 凭据库，值同样不碰任何 YAML。点「＋ 再加一把 key」会自动追加一个引用名
（`TAVILY_API_KEY_2`…）并多出一个输入框，请求在这些账号之间轮转；每行的「移除」可以删掉
一个（最后一个删不掉）。想手填也行，上面那段照写。
（宿主自带的凭据界面只管模型供应商的 key，像 `TAVILY_API_KEY` 这种自定义引用名
没有按钮；文件本来就是 0600，权限一旦放宽宿主会拒绝启动。）

credentials 存储优先于环境层。引用名必须是合法的 shell 标识符
（`[A-Za-z_][A-Za-z0-9_]*`）；写错的引用名当作「没配」而不是报错，一个手滑不该让
整条链挂掉。

### 多把 key

在卡片里点「＋ 再加一把 key」，或在设置里把引用名按行写上：

```
TAVILY_API_KEY_1
TAVILY_API_KEY_2
```

池会轮转：一次成功之后游标前进，连续请求不会总撞同一把。失败的 key 冷却
`cooldownMs`（默认 60 秒），冷却期间跳过。401/403 **且**消息里带明确的
invalid / revoked / expired 字样的，判为永久失效，本进程内不再使用。

冷却时长按失败性质分档，不是一律 60 秒：

- 上游给了 `Retry-After`（Tavily 的 429 会带）→ 用它，上限一天。
- 额度耗尽（Tavily 的 432 / 433：key 限额、套餐限额、PayGo 限额）→ 60× 冷却，且**不**标永久
  失效——key 本身没问题，只是这个周期没钱了，下个周期还能用。
- 限流（429 或 rate limit 措辞）→ 5× 冷却。
- 其它失败 → 1× 冷却。

池的状态跨调用存活（游标、冷却、失效集都在插件实例里）。在设置页改了 ref 列表或
冷却时长，池会重建——改了配置就该从干净的池开始。

池不查余额、不按剩余额度排序、不留调用历史。想要额度感知调度，用 `dsh-tavily-pool`。

## 设置

调参字段由宿主自动生成表单渲染。此外本插件自带一个极小、**零构建**的浏览器 bundle
（`lib/client.js`），在插件页加一张「API 密钥」卡片，用来填 Tavily / Exa / Firecrawl 的密钥。
卡片只经宿主的 `remote.credentials` 接口写入凭据库，不会把值存进任何配置文件。
眼睛按钮可以显示你**正在输入、还没保存**的草稿；已保存的密钥不会回读。
所有调参字段都是 `volatile`，改完即时生效。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `tavilyApiKeyRefs` | `["TAVILY_API_KEY"]` | Tavily key 引用名，按序尝试 |
| `exaApiKeyRefs` | `["EXA_API_KEY"]` | Exa key 引用名（默认已启用；填了 key 就进链，可在插件页停用） |
| `firecrawlApiKeyRefs` | `["FIRECRAWL_API_KEY"]` | Firecrawl key 引用名 |
| `tavilyExtractDepth` | `basic` | `basic` 或 `advanced` |
| `minContentChars` | `0` | 短于此长度就升级；`0` 表示只判空 |
| `totalBudgetMs` | `45000` | 单次抓取硬上限 |
| `tavilyTimeoutMs` | `15000` | 单段超时 |
| `exaTimeoutMs` | `15000` | Exa 单段超时 |
| `exaSearchType` | `auto` | Exa 搜索档位：`instant`/`fast`/`auto`/`deep-lite`/`deep`/`deep-reasoning`，越靠后越贵越慢 |
| `firecrawlTimeoutMs` | `30000` | 单段超时 |
| `httpTimeoutMs` | `10000` | 单段超时 |
| `maxBodyChars` | `100000` | 返回正文的截断点 |
| `cooldownMs` | `60000` | 失败 key 冷却多久 |
| `searchTotalBudgetMs` | `30000` | 单次搜索硬上限 |
| `providerOrder` | `["tavily", "exa", "firecrawl"]` | 供应商启用顺序，**搜索与抓取共用**；没配 key 的运行时跳过。插件页的排序/停用改的就是它。兜底是官方 `deepseek-official`（搜索）与本地 `http`（抓取） |
| `keyNotes` | `{}` | 每把 key 的本机备注（ref→一句话），只展示不参与请求 |
| `verboseLog` | `false` | 打开后把「这次由哪个后端服务」从 `debug` 升到 `info`，普通日志级别就能看见 |
| `searchProviderOrder` | 未设置 | **旧字段，仅用于升级迁移**。`providerOrder` 仍是默认值而此字段有值时沿用它的顺序；一旦在 `providerOrder` 里改过（含清空）就以新字段为准。不进设置表单，日常不用管 |
| `searchFallback` | `true` | 回落 `deepseek-official` |
| `fetchFallback` | `true` | 回落本地 `http` |
| `firecrawlOnlyMainContent` | `true` | 丢掉导航与页脚 |
| `firecrawlMaxAgeMs` | `172800000` | Firecrawl 缓存有效期，两天 |

## 错误

失败都带稳定的 `code`，工具层会把它放进结构化错误元数据：

| Code | 何时 |
| --- | --- |
| `WEB_SEARCH_ALL_PROVIDERS_FAILED` | 所有搜索后端都失败 |
| `WEB_SEARCH_BUDGET_EXHAUSTED` | 搜索总预算耗尽，没有任何后端跑完 |
| `WEB_FETCH_ALL_PROVIDERS_FAILED` | 所有抓取后端都失败 |
| `WEB_FETCH_BUDGET_EXHAUSTED` | 预算耗尽，没有任何后端跑完 |
| `WEB_INVALID_URL` | URL 非法、超长、非 http(s)、带内嵌凭据 |
| `WEB_ABORTED` | 调用方取消 |

## 回滚

把两个 provider 字段指回宿主自己的——**两行都要写**，因为 id-targeted 的 `config`
是整块替换：

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

然后卸掉插件。不需要清理密钥，因为从来没有写进去过。

## 许可证

MIT
