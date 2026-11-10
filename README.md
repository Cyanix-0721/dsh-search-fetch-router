# dsh-search-fetch-router

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that takes over `web_search`
and `web_fetch` with a **Tavily-first** routing chain, escalating to **Firecrawl** when the
page needs a real browser, and falling back to the host's own providers when nothing else
works.

Keys never touch a config file. They live in the DSH credentials store (or your
environment) and the plugin only ever holds a reference name.

## Routing

**Search** — Tavily key pool → the host's `deepseek-official` provider.

**Fetch** — depends on the URL:

| Situation | Chain |
| --- | --- |
| URL matches the whitelist | Firecrawl → Tavily → local `http` |
| Anything else | Tavily `/extract` → Firecrawl `/v2/scrape` → local `http` |

Firecrawl is used when Tavily cannot do the job, in three cases only:

1. the URL is whitelisted — the user already said "this site needs a browser";
2. Tavily errored (network, timeout, non-2xx);
3. Tavily returned nothing usable — empty body, `failed_results` non-empty, or a body
   shorter than `minContentChars`.

There is deliberately no "content looks incomplete" heuristic. Guessing costs Firecrawl
credits on pages that were already fine.

Every fetch runs under one hard budget (`totalBudgetMs`, default 45 s). Each backend gets
`min(its own timeout, whatever is left)`; when less than 2 s remains, no new backend starts.

## Install

Not on npm yet — install straight from the repository:

```bash
npx --yes @deepseek-ai/dsh plugin --profile web add \
  github:Cyanix-0721/dsh-search-fetch-router
```

Or, from a local checkout:

```bash
npx --yes @deepseek-ai/dsh plugin --profile web add \
  /path/to/dsh-search-fetch-router
```

Restart DSH afterwards. The bundle patch mounts the plugin and pins both providers.

## Keys

The plugin reads **reference names**, never values. Two ways to supply a value, both
outside every YAML file:

```yaml
# 1. DSH credentials store — ~/.dsh/.credentials.yaml, mode 0600, never in git.
#    Add the name under the existing `refs:` mapping.
version: 1
refs:
  TAVILY_API_KEY: tvly-...
  FIRECRAWL_API_KEY: fc-...
records: {}
```

```bash
# 2. environment layer — process env, or ~/.dsh/.env
export TAVILY_API_KEY=tvly-...
```

The host's own credential UI covers model-provider keys; an arbitrary reference name
like `TAVILY_API_KEY` has no button, so edit the `refs:` block directly. The file is
already 0600 and the host refuses to start if that ever widens.

The credentials store wins over the environment. Reference names must be valid shell
identifiers (`[A-Za-z_][A-Za-z0-9_]*`); a malformed name is treated as "not configured"
rather than as an error, so one typo cannot take the whole chain down.

### Multiple keys

Set the reference list in settings, one name per line:

```
TAVILY_API_KEY_1
TAVILY_API_KEY_2
```

The pool rotates: after a successful call the cursor moves on, so consecutive requests do
not hammer one key. A key that fails cools down for `cooldownMs` (default 60 s) and is
skipped while cooling. A key that fails with 401/403 **and** an explicit "invalid /
revoked / expired" message is marked dead for the rest of the process.

Pool state lives across calls — cursor, cooldowns, and the dead set all belong to the plugin
instance. Editing the reference list or the cooldown in the settings form rebuilds the pool,
because a changed configuration deserves a clean start.

The pool does not query balances, does not sort by remaining quota, and keeps no history.
If you want quota-aware scheduling, use `dsh-tavily-pool` instead.

## Settings

Every field is exposed through the host's auto-generated settings form — there is no
custom panel and no client-side build.

| Field | Default | Meaning |
| --- | --- | --- |
| `tavilyApiKeyRefs` | `["TAVILY_API_KEY"]` | Tavily key reference names, tried in order |
| `firecrawlApiKeyRefs` | `["FIRECRAWL_API_KEY"]` | Firecrawl key reference names |
| `firecrawlUrlPatterns` | `[]` | glob whitelist, matched against `host + path` |
| `tavilyExtractDepth` | `basic` | `basic` or `advanced` |
| `minContentChars` | `0` | escalate below this length; `0` means only emptiness counts |
| `totalBudgetMs` | `45000` | hard cap for one fetch |
| `tavilyTimeoutMs` | `15000` | per-segment timeout |
| `firecrawlTimeoutMs` | `30000` | per-segment timeout |
| `httpTimeoutMs` | `10000` | per-segment timeout |
| `maxBodyChars` | `100000` | truncation point for returned bodies |
| `cooldownMs` | `60000` | how long a failed key sits out |
| `searchFallback` | `true` | fall back to `deepseek-official` |
| `fetchFallback` | `true` | fall back to local `http` |
| `firecrawlOnlyMainContent` | `true` | drop nav and footers |
| `firecrawlMaxAgeMs` | `172800000` | Firecrawl cache TTL, two days |

### Whitelist syntax

Glob, not regex — a typo produces "no match", not a syntax error, and there is no ReDoS
surface. `*` matches a run of characters that contains no `/`; `**` matches anything.

```
docs.example.com/**        # that host, any path
*.medium.com/*             # one path segment on any medium.com subdomain
example.com                # bare host also matches every path under it
```

The match surface is `host + pathname` — scheme, port and query string are ignored.

## Errors

Failures carry a stable `code`, surfaced in the tool's structured error metadata:

| Code | When |
| --- | --- |
| `WEB_SEARCH_ALL_PROVIDERS_FAILED` | every search backend failed |
| `WEB_FETCH_ALL_PROVIDERS_FAILED` | every fetch backend failed |
| `WEB_FETCH_BUDGET_EXHAUSTED` | the budget ran out before any backend finished |
| `WEB_INVALID_URL` | bad, over-long, non-http(s), or credential-bearing URL |
| `WEB_ABORTED` | the caller cancelled |

## Rolling back

Point the two provider fields back at the host's own providers — keep **both** lines,
because an id-targeted `config` replaces the whole object:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

Then remove the plugin. No key material needs cleaning up, because none was ever written.

## License

MIT
