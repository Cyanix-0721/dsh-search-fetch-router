# AGENTS.md — dsh-search-fetch-router

面向在本仓库工作的 agent。用户读的是 `README.md` / `README.zh-CN.md`。

## 这个仓库是什么

一个 DSH（DeepSeek Harness）插件，接管 `ctx.web` 的搜索与抓取两条能力，路由顺序：

- **搜索与抓取共用一张 `providerOrder`**（默认 `tavily`、`exa`、`firecrawl`，没配 key 的运行时自动跳过；插件页卡片可排序/停用/改 key 名称）。搜索末尾可回落 DSH 官方 `deepseek-official`（走 magpie 网关）；抓取末尾可回落本地 `http`
- **输入框左侧有「搜索增强」总开关**（`enabled`，volatile，即时生效）：关掉=**旁路**，搜索走官方、抓取走本地 http，第三方 key 一律不调用，但配置保留、开回来即恢复（provider 被 patch 静态 pin，插件无法真正卸载）
- **结果条数三种取法**（`maxResultsMode`，插件页三个按钮）：`cap` 用统一上限 `maxSearchResults`（默认 20）/ `provider-max` 按各家硬上限（Tavily 20、Exa 100、Firecrawl 100）/ `provider-default` 不传、让各家用自己的默认值

高级抓取（整站爬、反爬、结构化抽取）不归本插件管，交给 firecrawl MCP。

provider id 是 `search-fetch-router`，搜索与抓取共用（seam 存两张表，同名不冲突）。

## 硬约束（改代码前先读，违反会静默坏掉）

1. **`available()` 必须恒 `true`。** `cordis.patch.yml` 把 `web.searchProvider` 与
   `web.fetchProvider` 静态 pin 到本插件。一个被 pin 的 provider 若 `available()`
   返回 `false`，seam 抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，不会回落。所有真实
   判断必须在 `search()` / `fetch()` 内部，失败降级而不是抛。
2. **`registerSearchProvider` 必须是 `apply()` 里第一条可能失败的效果语句。**
   patch 静态 pin 了 id，加载了却没注册 ⇒ 每次搜索硬抛 `WEB_PROVIDER_CONFIGURED_MISSING`。
   `registerFetchProvider` 相反：包在 `try` 里，失败只 warn。
3. **patch 里 id-targeted 的 `config` 是整块替换**，不是深度合并
   （`cordis-plugin-include` 的 `applyEntryPatches` 执行 `target[key] = value`）。
   `web` 的两个 provider 字段必须一起写；`tool-web` 的每个字段都要重写一遍。
4. **`tool-web.fetchTimeoutMs` 必须 ≥ `totalBudgetMs`，`tool-web.searchTimeoutMs` 必须 ≥
   `searchTotalBudgetMs`。** 工具层默认 30 s，本插件链预算 45 s / 30 s，不改就会被工具层
   腰斩。patch 里两个都设 60 s。
5. **密钥永不进 YAML。** 配置字段只存 credentials 引用名（`TAVILY_API_KEY` 这种）。
   测试里的 key 一律用一眼假的值（`fc-FAKE-TEST-KEY`）。
6. **`credentials.listRecords()` 只枚举 records，不枚举 refs。** 所以池的可枚举性来自
   配置里的 ref 名数组，不是服务。不要试图「扫出所有 TAVILY_API_KEY_*」。
7. **先解析 key，再决策链。** 默认 ref 名永远存在，用「ref 名数」判断可用性会恒真，
   于是「一个 key 都没填」被当成「有 Tavily」，最后报一串看不懂的后端失败。
8. **client bundle 的 `__ModuleLoader__.load({id})` 必须等于包名**（`dsh-search-fetch-router`），
   不是 patch 里的行 id。`dsh-client-modules` 用**包名**做 graph 行 id，并校验 chunk URL 是
   `${id}/client.js`；写错 id 就静默不加载。
9. **`plugins.detail.section` 是 list 座位，任何插件页都会渲染它**，组件必须自判
   `props.subject.kind === 'bundle' && props.subject.pkg.name === 'dsh-search-fetch-router'`，
   否则卡片会串到别人的插件页上。座位注册要带 `id`、不声明 `inject`。
10. **client bundle 只能 `require` 种子模块**（`react` / `react-dom` /
    `@deepseek-ai/dsh-client-ui-primitives` 等 9 个），手写 `React.createElement`、无 JSX、无构建。
    要别的宿主模块必须在 `dsh.client.inject` 里声明——但本项目只用种子，保持零 inject。
11. **密钥卡片只走 `ctx.remote.credentials.set/describe`**，值落 `~/.dsh/.credentials.yaml`。
    别改成自己发 HTTP 或用 `cordis.patch.yml` 存值，那就把「是否进 YAML」的初衷丢了。
12. **配置字段不要用 `z.union` / `z.enum` 做枚举校验**，一律 `z.string()` + 使用时用
    `normalize*` 白名单规整（坏的按默认处理）。Config 校验抛错会让**整个插件加载失败**，
    而 `web.searchProvider` / `web.fetchProvider` 都被 patch 静态 pin 到本插件，等于把
    `web_search`/`web_fetch` 一起弄挂——一个手写 YAML 的拼写错误不该有这种后果。
13. **`settings.mutate` 只接受 volatile 字段路径**；非 volatile 会抛
    `Config field "..." is not volatile`。要能热改的配置项必须 `.volatile()`。
14. **客户端调远端一律先剥 `{ok, value}` 信封**（`ctx.remote.settings.describe/mutate`、
    `ctx.remote.credentials.*` 都是这个形态）。不剥就会「写成功却显示没生效」：
    `findNamespaceView` 永远取不到视图、状态恒读默认。见 `lib/client.js` 的 `unwrapRemote()`。
15. **配置里的 ref 名数组一律写整个数组，不要按索引 `set`/`unset`。** 这些数组常常还只是
    schema 默认值、没真正落进配置文档；对不存在的数组按下标写会被 `configForms.mutate`
    整条拒绝（前端表现为「保存失败」）。见 `lib/client.js` 的 `addRef`/`removeRef`/`save`。
16. **缓存键必须纳入 `cacheGeneration` 与所有影响结果的配置字段。** 清空缓存靠前端把
    `cacheGeneration` 加一实现「逻辑失效」——它是 `.volatile()` 整数；缓存键漏掉它（或漏掉
    timeout / depth 等影响结果的字段）就会出现「点了清空、或改了配置，仍命中旧结果」。
    缓存条目只活在进程内存、不落盘，由 `lib/cache.js` 的 LRU + TTL 回收。

## 目录

```
index.js              apply()：注册两个 provider，只做装配
cordis.patch.yml      bundle patch：mount + pin provider + 提 tool-web 超时
lib/config.js         schemastery schema，全字段 .volatile()，零密钥
lib/router.js         纯决策：链顺序、升级判定、预算切片（无 I/O，最好测）
lib/search-backends.js 声明式搜索后端注册表：加供应商只改这里 + config 字段，执行层不变
lib/fetch-backends.js 声明式抓取后端注册表：只做单 URL 基础抓取，执行层同样不改
lib/urls.js           URL 校验（长度 / 协议 / 内嵌凭据）
lib/keyring.js        refs 池：轮转 / 冷却 / 永久失效
lib/rest.js          三家共用的 JSON POST 底座：超时组合 / 非 2xx / Retry-After / UA
lib/tavily.js         /search 与 /extract 的 REST
lib/exa.js            /search 与 /contents 的 REST
lib/firecrawl.js      /v2/scrape 与 /v2/search 的 REST 与响应映射
lib/official.js       官方 deepseek-official 搜索 + 本地 http 抓取
lib/errors.js         错误码与 WebError 包装
lib/text.js           Unicode 安全文本工具：按码点截断 + 清孤立代理 + 递归清洗字符串
lib/cache.js          进程内结果缓存：LRU + TTL + 字节上限 + cacheSignature
lib/execute.js        执行层：把决策落到调用上，失败降级
lib/client.js         零构建浏览器 bundle：设置卡片（填 key / 改 key 名称 / 排序停用 / 最大结果条数三档 / 诊断区 + 清空缓存 / 掩码）＋输入框左侧「搜索增强」启停按钮
scripts/check.mjs     跨平台语法检查：遍历 index.js + lib/*.js（`npm run check` 用它，新增 lib 文件自动纳入）
test/*.test.js        node --test，无框架依赖
```

`node_modules/@deepseek-ai/*` 是**指向 DSH 安装处的符号链接**，只为本地跑测试，不进 git。

## 命令

```bash
npm test                                    # node --test，全部
node --test test/router.test.js             # 单文件
npm run check                               # 语法检查：遍历 index.js + lib/*.js（跨平台）
node --check index.js                       # 单文件语法检查
node -e "const m=await import('./index.js'); console.log(m.Config({}))" --input-type=module
```

## 发布

打 tag 才发，见 `docs/MAINTAINING.md` 的 Releasing 段。两条不能碰的：

- `publish.yml` 的文件名是 npm trusted publisher 配置的一部分，改名等于发布立刻失效。
- `npm publish` 只允许在 `publish.yml` 里跑；npm 的 OIDC 校验看的是**调用方** workflow 名，挪进
  `test.yml` 或被 `workflow_call` 包一层都会对不上。

## 改代码时

- **决策与执行分开。** 新逻辑先问「这是纯决策吗」——是就进 `lib/router.js`，那里可以
  零成本测完所有分支。
- **新增搜索供应商走注册表，不加 if 分支。** 要动三处：`lib/search-backends.js` 的
  `SEARCH_BACKENDS` 加一项（含 `maxResults` 硬上限）+ `lib/config.js` 加 ref/timeout 字段 +
  `lib/client.js` 的 `SEARCH_PROVIDERS` 加一行（`field`/`base`/`caps`/`maxResults`，否则卡片
  不显示这家 key）；用户再把 id 填进 `providerOrder`。`lib/execute.js` 与 `lib/router.js`
  保持数据驱动，不写 `if (backend === ...)`。
- **新增抓取供应商同理走 `lib/fetch-backends.js`。** 抓取与搜索共用 `providerOrder`，没有单独固定顺序；
  适配器在注册表里，`run` 返回 `{kind:'result'}` 或 `{kind:'unusable',reason}`。**整站爬 /
  反爬 / 结构化抽取 / 批量任务仍归 firecrawl MCP，绝不塞进本插件**——本插件只是 `web_fetch`
  的一条单 URL 路由。
- **测试跟着降级路径写。** 这个插件的价值在「某一段挂了还能给出东西」，不在 happy path。
  新增后端时至少覆盖：成功、报错、内容为空、预算不足。
- **错误码稳定。** `lib/errors.js` 的 `CODES` 是外部契约，工具层会把 code 放进结构化
  错误元数据。加新码可以，改旧码不行。
- **注释写「为什么」。** 上面那些硬约束每一条都对应一次真实的静默失败，代码里的注释要能
  让下一个人不重犯。

## 不要做

- 不要装 `@deepseek-ai/*` 宿主包到本仓库的 `dependencies`。宿主永远从 dsh 安装处解析
  （`dsh-app-boot` 的 `resolveBundleDir`：安装处优先，profile 目录次之）。
- 不要复用 `@firecrawl/dsh-firecrawl` 的包：它的 peer 锁在 DSH `0.1.0-rc.6`，比当前宿主
  老两个 rc。抄实现，不抄依赖。
- 不要在 patch 里加 `insert` 以外的密钥、token、session id。
- 不要把 `.volatile()` 配置项改成非 volatile——`settings.mutate` 会拒写，设置卡片当场失效。
- 不要按索引写 ref 名数组（`set path:[field, index]`）——数组还没落盘时会被整条拒绝，改整数组。
- 不要把 `pnpm-lock.yaml`、`.plugin-manager/logs/`、`.dsh-market/` 提交进来。
