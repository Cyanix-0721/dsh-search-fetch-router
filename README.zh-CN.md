# dsh-search-fetch-router

[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件：接管 `web_search` 与
`web_fetch`，**Tavily 优先**，需要真实浏览器时升级到 **Firecrawl**，都不行再回落宿主
自己的提供方。

密钥不进任何配置文件。它们放在 DSH credentials 服务（或环境变量）里，插件手里只有
一个引用名。

## 路由

**搜索** —— Tavily key 池 → 宿主的 `deepseek-official`。

**抓取** —— 看 URL：

| 情况 | 链路 |
| --- | --- |
| URL 命中白名单 | Firecrawl → Tavily → 本地 `http` |
| 其他 | Tavily `/extract` → Firecrawl `/v2/scrape` → 本地 `http` |

只有三种情况会动用 Firecrawl：

1. URL 在白名单里——用户已经说了「这站要浏览器」；
2. Tavily 报错（网络、超时、非 2xx）；
3. Tavily 没拿到可用的东西——正文为空、`failed_results` 非空，或正文短于
   `minContentChars`。

**刻意不做**「内容看起来不完整」这种猜测。猜错就是白花 Firecrawl 的额度。

每次抓取跑在一个硬预算下（`totalBudgetMs`，默认 45 秒）。每段拿
`min(自己的超时, 剩余预算)`；剩余不足 2 秒就不再开新段。

## 安装

还没发到 npm，直接从仓库装：

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

宿主自带的凭据界面只管模型供应商的 key，像 `TAVILY_API_KEY` 这种自定义引用名没有按钮，
直接编辑 `refs:` 段。文件本来就是 0600，权限一旦放宽宿主会拒绝启动。

credentials 存储优先于环境层。引用名必须是合法的 shell 标识符
（`[A-Za-z_][A-Za-z0-9_]*`）；写错的引用名当作「没配」而不是报错，一个手滑不该让
整条链挂掉。

### 多把 key

在设置里把引用名按行写上：

```
TAVILY_API_KEY_1
TAVILY_API_KEY_2
```

池会轮转：一次成功之后游标前进，连续请求不会总撞同一把。失败的 key 冷却
`cooldownMs`（默认 60 秒），冷却期间跳过。401/403 **且**消息里带明确的
invalid / revoked / expired 字样的，判为永久失效，本进程内不再使用。

池的状态跨调用存活（游标、冷却、失效集都在插件实例里）。在设置页改了 ref 列表或
冷却时长，池会重建——改了配置就该从干净的池开始。

池不查余额、不按剩余额度排序、不留调用历史。想要额度感知调度，用 `dsh-tavily-pool`。

## 设置

全部字段由宿主自动生成表单渲染，没有自绘面板，也没有前端构建。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `tavilyApiKeyRefs` | `["TAVILY_API_KEY"]` | Tavily key 引用名，按序尝试 |
| `firecrawlApiKeyRefs` | `["FIRECRAWL_API_KEY"]` | Firecrawl key 引用名 |
| `firecrawlUrlPatterns` | `[]` | glob 白名单，匹配 `host + path` |
| `tavilyExtractDepth` | `basic` | `basic` 或 `advanced` |
| `minContentChars` | `0` | 短于此长度就升级；`0` 表示只判空 |
| `totalBudgetMs` | `45000` | 单次抓取硬上限 |
| `tavilyTimeoutMs` | `15000` | 单段超时 |
| `firecrawlTimeoutMs` | `30000` | 单段超时 |
| `httpTimeoutMs` | `10000` | 单段超时 |
| `maxBodyChars` | `100000` | 返回正文的截断点 |
| `cooldownMs` | `60000` | 失败 key 冷却多久 |
| `searchFallback` | `true` | 回落 `deepseek-official` |
| `fetchFallback` | `true` | 回落本地 `http` |
| `firecrawlOnlyMainContent` | `true` | 丢掉导航与页脚 |
| `firecrawlMaxAgeMs` | `172800000` | Firecrawl 缓存有效期，两天 |

### 白名单语法

用 glob，不是正则——写错只会「不匹配」，不会报语法错误，也没有 ReDoS 面。
`*` 匹配一段不含 `/` 的字符，`**` 匹配任意字符。

```
docs.example.com/**        # 该 host 的任意路径
*.medium.com/*             # 任意 medium.com 子域下的一段路径
example.com                # 裸 host 也匹配它下面的所有路径
```

匹配面是 `host + pathname`——协议、端口、查询串都不参与。

## 错误

失败都带稳定的 `code`，工具层会把它放进结构化错误元数据：

| Code | 何时 |
| --- | --- |
| `WEB_SEARCH_ALL_PROVIDERS_FAILED` | 所有搜索后端都失败 |
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
