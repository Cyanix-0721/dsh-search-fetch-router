# 交接：dsh-search-fetch-router

写给下一个接手这个仓库的 agent。用户读的是 `README.zh-CN.md`，工程约定读 `AGENTS.md`。

## 一句话现状

插件已实现、已提交、已推到 GitHub，`npm test` 90 全过。**还没在真实 DSH 里跑过**，
因为开发会话的 `~/.dsh/profiles/web/` 是只读的，装不进去。

- 仓库：`https://github.com/Cyanix-0721/dsh-search-fetch-router`
- 本地：`/home/slayer/repos/dsh-search-fetch-router`
- 最新提交：以 `main` 为准（`git log --oneline -1`）；本次交接基线为 `3a4d6f9`
- 分支：`main`，已跟踪 `origin/main`

## 它做什么

接管 `ctx.web` 的搜索与抓取两条能力，provider id `search-fetch-router`。

| 能力 | 链路 |
| --- | --- |
| 搜索 | Tavily key 池 → 宿主 `deepseek-official`（走 magpie 网关） |
| 抓取（URL 命中白名单） | Firecrawl → Tavily → 本地 `http` |
| 抓取（其他） | Tavily `/extract` → Firecrawl `/v2/scrape` → 本地 `http` |

Firecrawl 只在三种情况下被调用：URL 白名单命中、Tavily 报错、Tavily 没拿到可用内容
（正文为空、`failed_results` 非空、正文短于 `minContentChars`）。

**刻意不做**「内容看起来不完整就升级」——猜错就是白花额度。

密钥不进任何 YAML。配置只存 credentials 引用名，插件经 credentials 服务解析，失败
再回退环境变量层。

## 已验证 / 未验证

**已验证**

- `npm test` → 90 pass / 0 fail（`node --test`，无框架依赖，约 145ms）。
- `node --check` 全部源文件通过。
- `apply()` 装配有测试锁住两条硬约束（`test/index.test.js`）：两个 provider 都以
  pinned id 注册且 `available()` 恒 `true`；抓取注册失败（宿主无 fetch seam）时
  `doesNotThrow`，搜索 provider 仍注册。teardown 时 effect 会注销搜索 provider。
- CI 的依赖装法在本地复现过：`@deepseek-ai/*@next`（当前 `0.2.2-rc.1`）+
  `@deepseek-ai/schemastery@latest`，22 包，装完测试仍全过。
- 池状态跨调用存活有两条测试锁住（游标前进、失败 key 下次跳过）。
- 官方回落读 `web-search-deepseek` 段：有 settings 时请求打到配置的 `baseURL`，没有时
  回落 `DEEPSEEK_DEFAULT_BASE_URL`（2026-11-10 补测，见 `test/execute.test.js`）。
- 关键降级路径均有测试：`maxBodyChars` 截断置 `truncated`、Tavily 报错（非内容不可用）
  升级 Firecrawl、白名单命中但无 Firecrawl key 时降到 Tavily、Tavily 全失败回落官方。

**未验证**（这是下一阶段的主要工作）

- 没在真实 DSH 里装过、没跑过 `--dump-config`、没发过真实 Tavily / Firecrawl 请求。
- 本地 HTTP 回落（`HttpFetchProvider`）**成功路径没有单测**：它内部用
  `await import('undici')` 直连网络，绕过了测试里的 `globalThis.fetch` stub，要覆盖就得
  mock `undici` 模块，暂未做。失败/降级路径靠其余后端测试间接覆盖。

## 下一阶段要做的

1. **装进 DSH 试跑。** 命令在 `README.zh-CN.md` 的「安装」段。装完重启，看
   `~/.dsh/profiles/web/cordis.patch.yml` 里有没有本插件写进去的 `insert`，以及
   `web.searchProvider` / `web.fetchProvider` 是否都是 `search-fetch-router`。
2. **填两个 key。** `~/.dsh/.credentials.yaml`（0600）的 `refs:` 段加
   `TAVILY_API_KEY` 与 `FIRECRAWL_API_KEY`。宿主的凭据界面只管模型供应商的 key，
   自定义引用名没有按钮，只能手编文件。**注意：DSH 不脱敏工具输出，别在会话里
   `cat` 这个文件。**
3. **跑通真实请求。** 一次 `web_search`、一次普通页 `web_fetch`、一次需要浏览器的页
   （加到 `firecrawlUrlPatterns` 再抓），确认三条路径都走到。
4. **补 CI。** ~~已完成。~~ `gh auth refresh -s workflow` 后 `.github/workflows/ci.yml`
   已提交并推送（`66627ea`）。注意：工作流能被 GitHub 接收，但因**账号级 billing
   lock**（`The job was not started because your account is locked due to a billing
   issue.`）runner 起不来，与仓库公开与否、与 workflow 配置都无关，需用户处理账号账单。
5. **发布到 npm。** 包名 `dsh-search-fetch-router` 目前 404，可用。发了之后
   README 的安装段可以从 `github:` 改成包名。

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

- 仓库当前 checkout 在 `/home/slayer/repos/dsh-search-fetch-router`。workspace-write 策略
  下写入范围只到会话工作区，`~/.dsh/...` 这类工作区外路径改不了（装插件要另想办法）。
- WSL 侧 SSH 认证不可用（`Permission denied (publickey)`）。push 走 HTTPS + gh 凭证：
  remote 现在是干净的 `https://github.com/Cyanix-0721/dsh-search-fetch-router.git`，由
  `gh auth setup-git` 注入 token，**不再把 token 明文写进 URL**（旧写法已弃用）。
- `@deepseek-ai/*` 在 npm 上的 **`latest` 指向坏掉的 `0.0.1-rc.1`**（依赖已撤包的
  `@deepseek-ai/dsh-environment`，E404）。**必须用 `next` tag。**
- `npm pack` / `npx` 在开发会话里因 `EROFS` 失败（`~/.npm/_cacache` 只读）。
- `~/.dsh/.credentials.yaml` 受安全策略 `secret.deny-path` 保护，agent 直接读会被
  「BLOCKED by CC Safety Net」。key 的填写与确认只能由用户自己完成。
- DSH **不做工具输出脱敏**：`grep` 回显、`cat` 内容都会明文进会话日志
  （`~/.dsh/sessions/<workspace>/session-<id>/session.v3.jsonl.zstd`）。查密钥类内容只用
  `grep -c` / `grep -l`，不要回显匹配行。

## 相关文档

- 设计决策与理由：`docs/superpowers/specs/2026-11-10-dsh-search-fetch-router-design.md`
- 工程约定：`AGENTS.md`
- 用户视角：`README.zh-CN.md`
