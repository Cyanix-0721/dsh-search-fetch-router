# 交接：dsh-search-fetch-router

写给下一个接手这个仓库的 agent。用户读的是 `README.zh-CN.md`，工程约定读 `AGENTS.md`。

## 一句话现状

插件已实现、已提交、已推到 GitHub，`npm test` 249 全过。已**装进本机 web profile**，provider
已 pin 到 `search-fetch-router`。**已重启 DSH**，本会话内跑过 `web_search` 与 `web_fetch`
（`https://example.com`），均正常返回；per-request 命中哪家可开 `verboseLog` 在日志里看。
已发布到 npm：`0.3.0`（`latest` 指它；`beta` 仍是 `0.2.0-beta.0`，`alpha` 是 `0.1.0-alpha.0`）。
搜索与抓取都已抽象成声明式注册表（`lib/search-backends.js` + `lib/fetch-backends.js`）：
搜索与抓取共用一张 `providerOrder`（默认 `tavily`→`exa`→`firecrawl`），新增供应商只加注册项与配置字段，执行层不动。

- 仓库：`https://github.com/Cyanix-0721/dsh-search-fetch-router`
- 本地：`/home/slayer/repos/dsh-search-fetch-router`
- 最新提交：以 `main` 为准（`git log --oneline -1`）；搜索/抓取双注册表重构后的基线见 git log（起点 `ab04abb`）
- 分支：`main`，已跟踪 `origin/main`

## 它做什么

接管 `ctx.web` 的搜索与抓取两条能力，provider id `search-fetch-router`。

| 能力 | 链路 |
| --- | --- |
| 搜索 | 按 `providerOrder`（默认 `tavily`→`exa`→`firecrawl`）→ 宿主 `deepseek-official` 兜底 |
| 抓取 | 同一份 `providerOrder`：Tavily `/extract` / Exa `/contents` / Firecrawl `/v2/scrape` → 本地 `http` 兜底（注册表驱动） |

抓取按顺序往下换：当前供应商报错、正文为空，或（Tavily）`failed_results` 非空 / 正文短于 `minContentChars`，就换下一家。高级抓取交给 firecrawl MCP。

**刻意不做**「内容看起来不完整就升级」——猜错就是白花额度。

密钥不进任何 YAML。配置只存 credentials 引用名，插件经 credentials 服务解析，失败
再回退环境变量层。

搜索与抓取各是一张声明式注册表（`lib/search-backends.js` + `lib/fetch-backends.js`），共用同一份 `providerOrder`：
新增供应商只加注册项与配置字段，`execute` / `router` 不动；要出现在密钥卡片，`client.js`
的供应商列表加一项即可。详见设计文档「Adding a search provider / Adding a fetch provider」。

## 已知限制

- **`unusable` 即 break**：抓取 keyed 循环遇到 `unusable` 就不再试同后端其余 key。这是有意的
  假设——`unusable` 与用哪把 key 无关。若将来某后端的「不可用」其实是 per-key 的（按 key 的
  套餐限制抓取域名），必须把它改成抛错，否则会误弃整个后端。代码里已有注释。
- **跨域重定向**：宿主 `HttpFetchProvider` 只跟同源跳转，`lib/fetch-backends.js` 的
  `fetchFollowingCrossOrigin` 最多追 3 跳、每跳仍走 `provider.fetch`（不绕过宿主 URL 校验）。

## 已验证 / 未验证

**已验证**

- `npm test` → 249 pass / 0 fail（`node --test`，无框架依赖）。
- `node --check` 全部源文件通过。
- `apply()` 装配有测试锁住两条硬约束（`test/index.test.js`）：两个 provider 都以
  pinned id 注册且 `available()` 恒 `true`；抓取注册失败（宿主无 fetch seam）时
  `doesNotThrow`，搜索 provider 仍注册。teardown 时 effect 会注销两个 provider。
- 搜索供应商注册表是数据驱动的：`test/execute.test.js` 把一个假 backend 注入
  `createRouter(..., { searchBackends })` 并写进 `providerOrder`，断言它进链并被调用；
  `test/router.test.js` 覆盖 `planSearchChain` 新签名（去重 / 兜底 / 未知 id 跳过）。
  client `RouterSettingsCard` 的密钥分组由供应商列表驱动（`lib/client.js` 的 `SEARCH_PROVIDERS`）。
- 抓取后端同样是数据驱动的（`lib/fetch-backends.js` + `test/fetch-backends.test.js` 契约测试）：
  `lib/execute.js` 的 fetch 循环已无 `if (backend === ...)` 分支，与重构前逐字对齐（既有降级路径测试全过）。
- 新增可选的 Exa 搜索供应商（keyed，`lib/exa.js`，注册进 `SEARCH_BACKENDS`）；`execute.search` 加了与抓取对称的总预算 `searchTotalBudgetMs`，耗尽抛 `WEB_SEARCH_BUDGET_EXHAUSTED`。
- 搜索与抓取已合并成一张 `providerOrder`：Firecrawl 补了 `/v2/search` 搜索、Exa 补了 `/contents` 抓取，`planFetchChain` 改成与 `planSearchChain` 同构的数据驱动签名。
- 执行层的「后端归属」有 debug 日志（`note()`），并有测试锁住（`test/execute.test.js` 断言 debug 行含 `served by fake`）。
- CI 的依赖装法在本地复现过：`@deepseek-ai/*@next`（当前 `0.2.2-rc.1`）+
  `@deepseek-ai/schemastery@latest`，22 包，装完测试仍全过。
- 池状态跨调用存活有两条测试锁住（游标前进、失败 key 下次跳过）。
- 官方回落读 `web-search-deepseek` 段：有 settings 时请求打到配置的 `baseURL`，没有时
  回落 `DEEPSEEK_DEFAULT_BASE_URL`（2026-11-10 补测，见 `test/execute.test.js`）。
- 三家供应商共用一层 JSON POST 底座（`lib/rest.js`）：超时组合、非 2xx 错误体、
  `status` / `Retry-After` 挂载只写一份。此前是逐字重复的三份，给 Tavily 加 `Retry-After`
  时 Exa / Firecrawl 没跟上，同一类失败在 key 池里出现两种冷却时长。
- 调用方取消原样透传（`lib/rest.js`）：`postJson` 曾把 `AbortError` 包成普通 `Error`，
  上层靠 `error.name` 判断取消，包装后认不出——取消会被记成后端失败、惩罚 key、继续打下一家。
- 本地 http 兜底会跟随跨域重定向（`lib/fetch-backends.js` 的 `fetchFollowingCrossOrigin`）：
  宿主只跟同源跳转，实测 `docs.exa.ai` → `exa.ai` 会让整次抓取失败。最多三跳、记录已访问
  URL 防成环，每跳仍走宿主 `fetch`，URL 安全校验不被绕过。
- `User-Agent` 版本号与 `package.json` 一致，且只在 `lib/rest.js` 定义一处（`test/rest.test.js` 守住）。
- 配置里的枚举字段（`exaSearchType` / `tavilyExtractDepth`）都改成了 `z.string()` + 读取时规整：
  **Config 校验抛错会连带整个插件加载失败**，而两条链都被 pin 到本插件，一个手改 YAML 的
  拼写错误不该把 `web_search`/`web_fetch` 一起弄挂。
- 关键降级路径均有测试：`maxBodyChars` 截断置 `truncated`、Tavily 报错（非内容不可用）
  升级 Firecrawl、Tavily 全失败回落官方。
- **已装进 `~/.dsh/profiles/web`**（2026-11-11）：
  `dsh plugin --profile web add /home/slayer/repos/dsh-search-fetch-router` 以 `link:` 依赖
  写入 `package.json`，并**自动加入 `dsh.profile.bundles`（末尾）**。
  `dsh --profile web --dump-config` 通过：`web.searchProvider` 与 `web.fetchProvider` 均为
  `search-fetch-router`，`tool-web.fetchTimeoutMs` 为 60000，插件 `insert` 生效；从 profile
  目录 `import('dsh-search-fetch-router')` 也能解析（peer 由仓库 `node_modules` 的符号链接满足）。
- **生产影响（已获用户同意）**：web profile 原先由 `@tnnevol/dsh-failover-search` 接管
  `web_search`/`web_fetch`，装本插件后这两个 provider 已改由本插件接管。

**未验证**（这是下一阶段的主要工作）

- **逐后端归属需靠 debug 日志看**：执行层已加 `note()`（`lib/execute.js`），成功/失败都会
  `ctx.logger.debug('dsh-search-fetch-router: web_search served by <id> ...')`；宿主 logger 未开
  debug 级别时看不到，这只是观测点、不影响路由。
- 未在会话内确认 `~/.dsh/.credentials.yaml` 是否已有 `TAVILY_API_KEY` / `FIRECRAWL_API_KEY`
  （该文件被 `secret.deny-path` 拦截，agent 读不到）。缺 key 时搜索回落官方、抓取回落本地 http。
- 本地 HTTP 回落（`HttpFetchProvider`）成功路径**已测**：`test/execute.test.js` 起一个临时
  `node:http` server（127.0.0.1 随机端口），无 key 配置下 `router.fetch` 真实走到 `HttpFetchProvider`
  并拿到 200 + 正文。它内部 `await import('undici')` 绕过了 `globalThis.fetch` stub，所以用真服务器而非 mock。

## 下一阶段要做的

1. **真实运行已验证。** 已装进本机 web profile、provider pin 到 `search-fetch-router`；重启后
   `web_search` / `web_fetch` 均正常，Tavily / Exa / Firecrawl 的 key 已填
   （`~/.dsh/.credentials.yaml`，0600；DSH 不脱敏工具输出，别在会话里 `cat` 它）。
2. **CI 已就绪但跑不起来。** `.github/workflows/ci.yml` 已提交并推送，但**账号级 billing lock**
   让 runner 起不来（`The job was not started because your account is locked due to a billing
   issue.`），需用户处理账单。本地等价验证靠 `prepublishOnly: npm test`。
3. **npm 已发布。** `0.3.0` 已作为正式版上线，`latest` 指它；`beta` 仍停在 `0.2.0-beta.0`，
   `alpha` 是 `0.1.0-alpha.0`（旧预发布不删，避免已装 profile 解析失败）。发布/改 tag 都要过
   网页 EOTP（token 顶不了）；本机 `npm pack --dry-run` 需 `--cache "$(pwd)/.tmp-npm-cache"`
   （默认 cache 只读，EROFS）。

## 装 / 卸载到 profile

```bash
# 装（本地检出，link 依赖；会自动写入 dsh.profile.bundles 末尾）
dsh plugin --profile web add /home/slayer/repos/dsh-search-fetch-router

# 卸载（pnpm remove 后，手动从 ~/.dsh/profiles/web/package.json 的
# dsh.profile.bundles 删掉 "dsh-search-fetch-router" 这一行）
dsh plugin --profile web remove dsh-search-fetch-router
```

**回滚（本机 2026-11-11 装之前的备份，重启前随时可做）：**

```bash
cd ~/.dsh/profiles/web
cp package.json.bak-20261111-000329 package.json
cp pnpm-lock.yaml.bak-20261111-000329 pnpm-lock.yaml
cp cordis.patch.yml.bak-20261111-000329 cordis.patch.yml
pnpm install
```

## 硬约束（改代码前必读）

`AGENTS.md` 里有完整十五条，这里只列最容易踩的：

- **`available()` 必须恒 `true`。** patch 静态 pin 了 id，被 pin 的 provider 自称不可用
  会硬抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，不会回落。
- **`registerSearchProvider` 必须是 `apply()` 里第一条可能失败的效果语句。** 加载了却没
  注册 ⇒ 每次搜索硬抛 `WEB_PROVIDER_CONFIGURED_MISSING`。
- **patch 里 id-targeted 的 `config` 是整块替换**，不是深度合并。`web` 的两个 provider
  字段必须一起写。
- **`tool-web.fetchTimeoutMs` 必须 ≥ `totalBudgetMs`**（patch 里设 60s，工具层默认 30s）。
- **先解析 key 再决策链。** 默认 ref 名永远存在，用 ref 名数判断可用性会恒真。
- **池必须跨调用存活。** 每次调用新建 `KeyRing` 会让轮转和冷却变成死代码。

## 本机跑测试

`node_modules/@deepseek-ai/*` 是指向 DSH 安装处的符号链接，只为本地解析，不进 git：

```bash
cd /home/slayer/repos/dsh-search-fetch-router
npm test
```

链接断了就重建（DSH 安装处路径可能随 npx 缓存变）：

```bash
DSH_INSTALL=/home/slayer/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai
for p in schemastery cordis dsh-web dsh-credentials dsh-launch-environment \
         dsh-settings dsh-web-fetch-http dsh-web-search-deepseek dsh-llm dsh-tools cosmokit; do
  ln -sfn "$DSH_INSTALL/$p" "node_modules/@deepseek-ai/$p"
done
```

## 环境坑（这台机器上）

- 仓库当前 checkout 在 `/home/slayer/repos/dsh-search-fetch-router`。`~/.dsh/...` 在会话工作区
  之外，默认 workspace-write 策略改不了；装插件需 danger-full-access（本机 2026-11-11 已用
  danger-full-access 完成安装）。
- WSL 侧 SSH 认证不可用（`Permission denied (publickey)`）。push 走 HTTPS + gh 凭证：
  remote 现在是干净的 `https://github.com/Cyanix-0721/dsh-search-fetch-router.git`，由
  `gh auth setup-git` 注入 token，**不再把 token 明文写进 URL**（旧写法已弃用）。
- `@deepseek-ai/*` 在 npm 上的 **`latest` 指向坏掉的 `0.0.1-rc.1`**（依赖已撤包的
  `@deepseek-ai/dsh-environment`，E404）。**必须用 `next` tag。**
- `npm pack` / `npx` 在开发会话里因 `EROFS` 失败（`~/.npm/_cacache` 只读）。
- `~/.dsh/.credentials.yaml` 受安全策略 `secret.deny-path` 保护，**即使 danger-full-access**
  也拦（CC Safety Net 是插件层 hook，不走文件沙箱）。key 的填写与确认只能由用户自己完成。
- DSH **不做工具输出脱敏**：`grep` 回显、`cat` 内容都会明文进会话日志
  （`~/.dsh/sessions/<workspace>/session-<id>/session.v3.jsonl.zstd`）。查密钥类内容只用
  `grep -c` / `grep -l`，不要回显匹配行。

## 相关文档

- 设计决策与理由：`docs/superpowers/specs/2026-11-10-dsh-search-fetch-router-design.md`
- 工程约定：`AGENTS.md`
- 用户视角：`README.zh-CN.md`
