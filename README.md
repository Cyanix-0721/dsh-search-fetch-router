# dsh-search-fetch-router

**English** · [简体中文](./README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that takes over `web_search`
and `web_fetch` with a **Tavily-first** routing chain, escalating to **Firecrawl** when the
page needs a real browser, and falling back to the host's own providers when nothing else
works.

Keys never touch a config file. They live in the DSH credentials store (or your
environment) and the plugin only ever holds a reference name.

## Routing

**Search & fetch** — both follow the same `providerOrder` (default
`["tavily", "exa", "firecrawl"]`; providers without a key are skipped at runtime). For search
the host's `deepseek-official` is appended as a fallback when `searchFallback` is on; for fetch
the local `http` fetcher is appended when `fetchFallback` is on. Disabling a provider on the
plugin-page card removes it from **both** chains. The card also lets you reorder (drag or
arrows) and rename each key, and shows a masked preview of each stored key.

Each provider is used for search and/or fetch depending on what it implements:

| Provider | Search | Fetch |
| --- | --- | --- |
| Tavily | `/search` | `/extract` |
| Exa | `/search` | `/contents` |
| Firecrawl | `/v2/search` | `/v2/scrape` |

A fetch walks the order and moves on to the next provider when the current one produced
nothing usable — it errored, returned an empty body, or (Tavily) `failed_results` non-empty or
a body shorter than `minContentChars`. There is deliberately no "content looks incomplete"
heuristic; guessing costs credits on pages that were already fine.

Anything fancier — multi-page crawl, anti-bot, structured extraction — is outside this plugin's
scope; for those, the firecrawl MCP tools are the recommendation.

Every fetch runs under one hard budget (`totalBudgetMs`, default 45 s). Each provider gets
`min(its own timeout, whatever is left)`; when less than 2 s remains, no new provider starts.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full mental model (one `providerOrder`, two chains) and the invariants the code must keep.

## Adding a search provider

Search backends are **declaratively registered** — the execution layer has no per-provider
branch. To add one, touch three places:

1. Add an entry to `SEARCH_BACKENDS` in `lib/search-backends.js`: `id`, `label`,
   `keyRefsField`, `timeoutField`, `defaultTimeoutMs`, and `run({apiKey, request, signal,
   timeoutMs})` returning the seam's `WebSearchResult`. For a host capability with no key
   pool, set `keyRefsField: null` and implement `isAvailable(ctx)` instead.
2. Add its key-refs array field and per-call timeout field to `lib/config.js` (both
   `.volatile()`).
3. Have the user put its `id` into `providerOrder`.

A keyed provider (`keyRefsField` non-null) automatically gets rotation / cooldown / dead-key
skipping; a keyless one is called once behind `isAvailable`. `lib/execute.js` and
`lib/router.js` need no change. See the "a newly registered backend is picked up …" test in
`test/execute.search.test.js`, which proves it by injecting a registry.

The **API keys** card in the browser bundle renders a provider list from `lib/client.js`
(`SEARCH_PROVIDERS`); a new keyed provider needs one entry there to show a key input (the
`run` and config fields can land first — the card can follow).

## Adding a fetch provider

Fetch backends are **declaratively registered** in `lib/fetch-backends.js` and share the same
`providerOrder` as search — there is no separate fixed order. To add one:

1. Add an entry to `FETCH_BACKENDS`: `id`, `label`, `keyRefsField`, `timeoutField`,
   `defaultTimeoutMs`, and `run({apiKey, ctx, request, signal, budgetMs, read, maxBodyChars})`.
   `run` returns `{kind:'result', result}` (success) or `{kind:'unusable', reason}` (nothing
   usable — move on to the next provider without penalising the key); a thrown error is a
   key-level failure that rotates the pool.
2. Add its key-refs array and per-call timeout field to `lib/config.js` (both `.volatile()`).
3. If it should serve search too, register a search adapter under the same id in
   `lib/search-backends.js`; otherwise it only appears in the fetch chain.
4. Have the user put its `id` into `providerOrder`.

5. Tests can inject a registry via `createRouter(ctx, config, {fetchBackends: {...}})` —
   same as the search side's `searchBackends` — to prove a new provider is picked up without
   touching production code.

**Boundary:** whole-site crawling, anti-bot handling, structured extraction and batch jobs do
**not** belong here — they go to the firecrawl MCP. This plugin only routes a single-URL
`web_fetch`. `lib/execute.js` and `lib/router.js` need no change.

## Install

Requires Node ≥ 24.9.0 — the same floor the DSH host (`@deepseek-ai/dsh` ≥ 0.2.2-rc.1) enforces.

Install into a DSH profile — from npm (`dsh-search-fetch-router@latest`) or straight from the repository:

```bash
# from npm (append @beta / @alpha / @next for a prerelease)
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-search-fetch-router

# from the repository
npx --yes @deepseek-ai/dsh plugin --profile web add \
  github:Cyanix-0721/dsh-search-fetch-router
```

Or, from a local checkout:

```bash
npx --yes @deepseek-ai/dsh plugin --profile web add \
  /path/to/dsh-search-fetch-router
```

Restart DSH afterwards. The bundle patch mounts the plugin and pins both providers.

Prereleases are published under their own npm tag, so `latest` always stays stable. To try one:
`dsh-search-fetch-router@beta` (or `@alpha` / `@next`).

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

The easiest way to fill these in is the **API keys** card this plugin adds to its own
page under **插件 / Plugins** — each row has an editable reference name and a password
field, saved straight to the DSH credentials store. Press **+ Add a key row** to append
another reference name (`TAVILY_API_KEY_2`, …) and a new field; the pool rotates across
them, and a per-row **Remove** drops one (you can never delete the last). You can rename a
row's reference name in place; renaming does not move an already-stored key, so re-enter it
under the new name. Values still never touch a YAML
file. If you would rather edit by hand, the block above works too. (The host's built-in
credential UI only covers model-provider keys, so an arbitrary name like `TAVILY_API_KEY`
has no button there; the file is already 0600 and the host refuses to start if that ever
widens.)

The credentials store wins over the environment. Reference names must be valid shell
identifiers (`[A-Za-z_][A-Za-z0-9_]*`); a malformed name is treated as "not configured"
rather than as an error, so one typo cannot take the whole chain down.

### Multiple keys

Press **+ Add another key** in the card, or set the reference list in settings, one name per
line:

```
TAVILY_API_KEY_1
TAVILY_API_KEY_2
```

The pool rotates: after a successful call the cursor moves on, so consecutive requests do
not hammer one key. A key that fails cools down for `cooldownMs` (default 60 s) and is
skipped while cooling. A key that fails with 401/403 **and** an explicit "invalid /
revoked / expired" message is marked dead for the rest of the process.

The cooldown length depends on the failure, not just on `cooldownMs`:

- `Retry-After` from upstream (Tavily sends it on 429) → use it, capped at one day.
- Quota exhausted (Tavily 432 / 433: key, plan, or pay-as-you-go limit) → 60× cooldown,
  and the key is **not** marked dead: the key is fine, it just has no budget this cycle.
- Rate limited (429 or "rate limit" wording) → 5× cooldown.
- Anything else → 1× cooldown.

Pool state lives across calls — cursor, cooldowns, and the dead set all belong to the plugin
instance. Editing the reference list or the cooldown in the settings form rebuilds the pool,
because a changed configuration deserves a clean start.

The pool does not query balances, does not sort by remaining quota, and keeps no history.
If you want quota-aware scheduling, use `dsh-tavily-pool` instead.

## Settings

The tuning fields are exposed through the host's auto-generated settings form. On top of
that, this plugin ships one tiny, **zero-build** browser bundle (`lib/client.js`) that adds
an **API keys** card to its plugin page for filling the Tavily / Exa / Firecrawl secrets. An eye
button reveals the value you are currently typing (still unsaved); a stored secret is never
read back. The
card only writes to the credentials store through the host's `remote.credentials` API — it
never stores a value in a config file. Every tuning field is `volatile`, so changes apply
live.

| Field | Default | Meaning |
| --- | --- | --- |
| `tavilyApiKeyRefs` | `["TAVILY_API_KEY"]` | Tavily key reference names, tried in order |
| `exaApiKeyRefs` | `["EXA_API_KEY"]` | Exa key reference names (enabled by default; a set key joins the chain, disable in the card) |
| `firecrawlApiKeyRefs` | `["FIRECRAWL_API_KEY"]` | Firecrawl key reference names |
| `tavilyExtractDepth` | `basic` | `basic` or `advanced` |
| `tavilySearchDepth` | `basic` | `basic` / `fast` / `ultra-fast` (1 credit) or `advanced` (2 credits) |
| `tavilyTopic` | `general` | `general` / `news` / `finance` |
| `minContentChars` | `0` | escalate below this length; `0` means only emptiness counts |
| `totalBudgetMs` | `45000` | hard cap for one fetch |
| `tavilyTimeoutMs` | `15000` | per-segment timeout |
| `exaTimeoutMs` | `15000` | per-segment timeout (Exa) |
| `exaSearchType` | `auto` | Exa search mode: `instant`/`fast`/`auto`/`deep-lite`/`deep`/`deep-reasoning` — later ones cost more and run slower |
| `firecrawlTimeoutMs` | `30000` | per-segment timeout |
| `httpTimeoutMs` | `10000` | per-segment timeout |
| `maxBodyChars` | `100000` | truncation point for returned bodies |
| `maxSearchResults` | `20` | upper bound on results requested per provider; a smaller `maxResults` on the request is respected; only used when `maxResultsMode=cap` |
| `maxResultsMode` | `cap` | how many results to request: `cap` = the unified `maxSearchResults`; `provider-max` = each provider's own hard limit (Tavily 20 / Exa 100 / Firecrawl 100); `provider-default` = omit the count so each provider applies its default |
| `cooldownMs` | `60000` | how long a failed key sits out |
| `searchTotalBudgetMs` | `30000` | hard cap for one search |
| `providerOrder` | `["tavily", "exa", "firecrawl"]` | provider ids in enable order — used by **both** search and fetch; providers without a key are skipped at runtime. The card's reorder/disable edits this list. `deepseek-official` (search) and local `http` (fetch) are the fallbacks |
| `enabled` | `true` | master switch (the "Search boost" toggle at the left of the composer). Off = **bypass only**: search goes straight to the official `deepseek-official`, fetch to the local `http`; no third-party key is called, and all keys/order stay as configured. Applies live, no restart |
| `verboseLog` | `false` | when on, the "which backend served this" line moves from `debug` to `info`, so it shows at the normal log level |
| `searchFallback` | `true` | fall back to `deepseek-official` |
| `fetchFallback` | `true` | fall back to local `http` |
| `firecrawlOnlyMainContent` | `true` | drop nav and footers |
| `firecrawlMaxAgeMs` | `172800000` | Firecrawl cache TTL, two days |
| `cacheEnabled` | `true` | in-memory result cache for both search and fetch; a hit skips every provider. Off = bypass |
| `cacheTtlMs` | `300000` | entry lifetime in ms; `0`/negative falls back to the 5-minute default, and values below 60 s are clamped to 60 s |
| `cacheMaxEntries` | `100` | max cached entries (LRU); `0` disables the cache |
| `cacheMaxBytes` | `8000000` | approximate byte ceiling — the oldest entries evict first; `0` means no byte limit |
| `cacheGeneration` | `0` | logical cache version — "Clear cache" in the card bumps it, invalidating every existing entry at once |

## Errors

Failures carry a stable `code`, surfaced in the tool's structured error metadata:

| Code | When |
| --- | --- |
| `WEB_SEARCH_ALL_PROVIDERS_FAILED` | every search backend failed |
| `WEB_SEARCH_BUDGET_EXHAUSTED` | the search budget ran out before any backend finished |
| `WEB_FETCH_ALL_PROVIDERS_FAILED` | every fetch backend failed |
| `WEB_FETCH_BUDGET_EXHAUSTED` | the budget ran out before any backend finished |
| `WEB_INVALID_URL` | bad, over-long, non-http(s), or credential-bearing URL |
| `WEB_INVALID_QUERY` | empty or blank search query |
| `WEB_ABORTED` | the caller cancelled |

### Debugging a failure

Set `verboseLog` to `true` to get one line per request naming the backend that served it and how long it took (`web_search served by tavily (key TAVILY_API_KEY) in 812ms`), or — when everything failed — a `... all backends failed: <summary>` line where each provider's error is spelled out.

- `*_ALL_PROVIDERS_FAILED` — read the `summary`; it lists every provider's error. Usually an empty/invalid key, a quota-exhausted key, or a provider outage. Check the key values and the per-key names on the card.
- `*_BUDGET_EXHAUSTED` — the budget ran out before any provider finished; usually too many providers/keys for the budget, or one slow provider. Raise `searchTotalBudgetMs` / `totalBudgetMs`, or lower the per-provider timeouts.
- `WEB_INVALID_URL` — only `http(s)` URLs without embedded credentials are fetched.
- `WEB_ABORTED` — the caller cancelled the request; not a plugin failure.

A JS-heavy or cross-origin-redirecting page is expected to be limited; for anything beyond a single URL's content, use the firecrawl MCP tools.

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
