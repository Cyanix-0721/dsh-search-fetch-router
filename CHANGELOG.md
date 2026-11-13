# Changelog

本文件记录本插件的可见变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。本插件仅从 git 仓库分发，不发布到 npm（`package.json` 已设 `"private": true`）。

## [0.1.0] - 未发布

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
