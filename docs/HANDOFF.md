# 交接：dsh-search-fetch-router

写给下一个接手这个仓库的 agent。用户读的是 `README.zh-CN.md`，工程约定读 `AGENTS.md`。

## 一句话现状

插件已实现、已提交、已推到 GitHub，`npm test` 112 全过。已**装进本机 web profile**，provider
已 pin 到 `search-fetch-router`。**已重启 DSH**，本会话内跑过一次 `web_search` 与一次
`web_fetch`（`https://example.com`），均正常返回；未逐条确认底层实际走的是哪个后端。
搜索与抓取都已抽象成声明式注册表（`lib/search-backends.js` + `lib/fetch-backends.js`）：
搜索按 `searchProviderOrder`、抓取按固定顺序，新增供应商只加注册项与配置字段，执行层不动。

- 仓库：`https://github.com/Cyanix-0721/dsh-search-fetch-router`
- 本地：`/home/slayer/repos/dsh-search-fetch-router`
- 最新提交：以 `main` 为准（`git log --oneline -1`）；搜索/抓取双注册表重构后的基线见 git log（起点 `ab04abb`）
- 分支：`main`，已跟踪 `origin/main`

## 它做什么

接管 `ctx.web` 的搜索与抓取两条能力，provider id `search-fetch-router`。

| 能力 | 链路 |
| --- | --- |
| 搜索 | 按 `searchProviderOrder`（默认 Tavily key 池）→ 宿主 `deepseek-official` 兜底 |
| 抓取 | Tavily `/extract` → Firecrawl `/v2/scrape` → 本地 `http`（固定顺序，注册表驱动） |

Firecrawl 只在两种情况下被调用：Tavily 报错、Tavily 没拿到可用内容
（正文为空、`failed_results` 非空、正文短于 `minContentChars`）。高级抓取交给 firecrawl MCP。

**刻意不做**「内容看起来不完整就升级」——猜错就是白花额度。

密钥不进任何 YAML。配置只存 credentials 引用名，插件经 credentials 服务解析，失败
再回退环境变量层。

搜索供应商是一张声明式注册表（`lib/search-backends.js`）+ 配置项 `searchProviderOrder`：
新增供应商只加注册项与配置字段，`execute` / `router` 不动，`client.js` 的 `KEY_GROUPS`
加一行即可让它出现在密钥卡片里。详见设计文档「Adding a search provider」。

## 已验证 / 未验证

**已验证**

- `npm test` → 112 pass / 0 fail（`node --test`，无框架依赖）。
- `node --check` 全部源文件通过。
- `apply()` 装配有测试锁住两条硬约束（`test/index.test.js`）：两个 provider 都以
  pinned id 注册且 `available()` 恒 `true`；抓取注册失败（宿主无 fetch seam）时
  `doesNotThrow`，搜索 provider 仍注册。teardown 时 effect 会注销两个 provider。
- 搜索供应商注册表是数据驱动的：`test/execute.test.js` 把一个假 backend 注入
  `createRouter(..., { searchBackends })` 并写进 `searchProviderOrder`，断言它进链并被调用；
  `test/router.test.js` 覆盖 `planSearchChain` 新签名（去重 / 兜底 / 未知 id 跳过）。
  client `RouterSettingsCard` 的密钥分组改由 `KEY_GROUPS` 驱动（行为不变，11 个 client 测试仍过）。
- 抓取后端同样是数据驱动的（`lib/fetch-backends.js` + `test/fetch-backends.test.js` 契约测试）：
  `lib/execute.js` 的 fetch 循环已无 `if (backend === ...)` 分支，与重构前逐字对齐（既有降级路径测试全过）。
- 新增可选的 Exa 搜索供应商（keyed，`lib/exa.js`，注册进 `SEARCH_BACKENDS`）；`execute.search` 加了与抓取对称的总预算 `searchTotalBudgetMs`，耗尽抛 `WEB_SEARCH_BUDGET_EXHAUSTED`。
- 执行层的「后端归属」有 debug 日志（`note()`），并有测试锁住（`test/execute.test.js` 断言 debug 行含 `served by fake`）。
- CI 的依赖装法在本地复现过：`@deepseek-ai/*@next`（当前 `0.2.2-rc.1`）+
  `@deepseek-ai/schemastery@latest`，22 包，装完测试仍全过。
- 池状态跨调用存活有两条测试锁住（游标前进、失败 key 下次跳过）。
- 官方回落读 `web-search-deepseek` 段：有 settings 时请求打到配置的 `baseURL`，没有时
  回落 `DEEPSEEK_DEFAULT_BASE_URL`（2026-11-10 补测，见 `test/execute.test.js`）。
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
- 本地 HTTP 回落（`HttpFetchProvider`）**成功路径没有单测**：它内部用
  `await import('undici')` 直连网络，绕过了测试里的 `globalThis.fetch` stub，要覆盖就得
  mock `undici` 模块，暂未做。失败/降级路径靠其余后端测试间接覆盖。

## 下一阶段要做的

1. **重启 DSH 让插件真正加载。** 装与 `--dump-config` 静态验证已完成（见上）。重启后确认
   运行时 `web.searchProvider` / `web.fetchProvider` 仍是 `search-fetch-router`，且
   `web_search` / `web_fetch` 不报 `WEB_PROVIDER_CONFIGURED_MISSING` / `_UNAVAILABLE`。
2. **填两个 key。** `~/.dsh/.credentials.yaml`（0600）的 `refs:` 段加
   `TAVILY_API_KEY` 与 `FIRECRAWL_API_KEY`。宿主的凭据界面只管模型供应商的 key，
   自定义引用名没有按钮，只能手编文件。**注意：DSH 不脱敏工具输出，别在会话里
   `cat` 这个文件。**
3. **跑通真实请求。** 一次 `web_search`、一次普通页 `web_fetch`，以及一次反爬/JS 重的页
   （确认 Tavily 拿不到时能降到 Firecrawl），确认各条路径都走到。
4. **补 CI。** ~~已完成。~~ `gh auth refresh -s workflow` 后 `.github/workflows/ci.yml`
   已提交并推送（`66627ea`）。注意：工作流能被 GitHub 接收，但因**账号级 billing
   lock**（`The job was not started because your account is locked due to a billing
   issue.`）runner 起不来，与仓库公开与否、与 workflow 配置都无关，需用户处理账号账单。
5. **发布到 npm。** 包名 `dsh-search-fetch-router` 目前 404，可用。发了之后
   README 的安装段可以从 `github:` 改成包名。

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

`AGENTS.md` 里有完整七条，这里只列最容易踩的：

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
