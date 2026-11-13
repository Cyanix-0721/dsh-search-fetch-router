# dsh-search-fetch-router — Design

Date: 2026-11-10
Status: implemented (v0.1.0)

## Problem

DSH ships two web capabilities behind one seam (`ctx.web`): search and fetch. Out of the
box, search goes to `deepseek-official` and fetch to a local HTTP client that cannot run
JavaScript. The user's actual usage is different:

- **Search** should be Tavily — free tier, 1000 credits/month, good enough for daily work.
- **Fetch** should be Tavily first, because `/extract` returns clean markdown and does not
  pay the browser tax. But some pages genuinely need a browser (SPAs, docs behind JS
  routers), and for those Firecrawl is the right tool.
- DSH's own search provider already routes through the user's magpie gateway, which has
  Tavily configured. It is a good last resort, not a first choice.
- **Keys must not appear in any config file.** The existing third-party Tavily plugin
  (`@tnnevol/dsh-failover-search`) writes plaintext keys into `cordis.patch.yml`. That file
  is 0600, but it is also the file people copy into dotfiles repos, back up, and grep —
  and DSH does not redact tool output, so a single `grep` puts the key in a session log.

## Goals

1. Search and fetch both prefer Tavily; Firecrawl is an escalation, not a default.
2. Firecrawl is used exactly when it is needed — a whitelisted URL, a Tavily error, or
   Tavily returning nothing usable. No "content looks incomplete" guessing.
3. Zero key material in any YAML. Configuration holds credential *reference names* only.
4. Multiple keys per provider, rotated, with cooldown — but no quota-aware scheduling.
5. Pure host plugin, no client build, settings rendered by the host's own form generator.
6. Failures degrade. A dead key or a down provider must not take `web_search` offline.

## Non-goals

- Balance/quota awareness (`/usage` polling), call history, cross-month recovery probes.
  That is `dsh-tavily-pool`'s ~3000-line territory; this plugin deliberately stays small.
- A custom settings panel. Every field is a `volatile` schema entry.
- A quota-aware scheduling or provider-ranking engine. The search chain is a plain,
  user-ordered list (`providerOrder`) that falls back to `deepseek-official` — adding a
  provider is a registry entry, not a policy.
- Replacing the host's tool layer (`web_search` / `web_fetch` tool names are unchanged).

## Architecture

```
index.js            apply(): register providers, nothing else
  └── lib/execute.js    execution: try each backend, degrade on failure
        ├── lib/router.js     pure decisions (chain order, escalation, budget slicing)
        ├── lib/search-backends.js  declarative search backend registry (add a provider here)
        ├── lib/fetch-backends.js   declarative fetch backend registry (single-URL only)
        ├── lib/keyring.js    refs pool: rotate, cooldown, permanent death
        ├── lib/rest.js       shared JSON-POST base: timeout, non-2xx, Retry-After, UA
        ├── lib/tavily.js     POST /search, POST /extract
        ├── lib/exa.js        POST /search, POST /contents
        ├── lib/firecrawl.js  POST /v2/scrape, POST /v2/search
        ├── lib/official.js   host's DeepSeekSearchProvider + HttpFetchProvider
        ├── lib/urls.js       URL validation
        ├── lib/errors.js     stable codes, WebError wrapping
        └── lib/config.js     schemastery schema, all volatile, zero secrets
```

The split between `router.js` and `execute.js` is the load-bearing one: everything that can
be decided without I/O lives in `router.js`, so the interesting branches are testable
without stubbing `fetch`. `execute.js` is the only file that touches the network or the
credentials service.

## Routing

### Search

Search backends are declarative. `lib/search-backends.js` holds a registry; each entry is
`{id, label, keyRefsField|null, timeoutField|null, defaultTimeoutMs, isAvailable?, run()}`.
The chain is built from the user's `providerOrder` (default `["tavily", "exa", "firecrawl"]`), then the
`deepseek-official` fallback is appended when `searchFallback` is on. A keyed backend gets the
`KeyRing` rotation/cooldown for free; a keyless one (`deepseek-official`) is called once.
`lib/execute.js` and `lib/router.js` are data-driven and contain no `if (backend === ...)`.

```
providerOrder: [ tavily, … ] ──(all keys failed)──> deepseek-official (fallback)
```

`deepseek-official` is constructed directly (`new DeepSeekSearchProvider(resolveOptions)`)
rather than re-registering its settings namespace — that namespace belongs to the host and
cannot be installed twice.

Built-in search providers are `tavily`, `exa` and `firecrawl` (all keyed), with
`deepseek-official` as the keyless fallback.

#### Adding a search provider

1. Register it in `lib/search-backends.js` — `run(args)`. A keyed backend receives
   `{apiKey, ctx, request, signal, timeoutMs}`; a keyless one receives `{ctx, request, signal}`.
   Add `isAvailable(ctx)` only if it is keyless.
2. Add its config field(s) in `lib/config.js` (a `…ApiKeyRefs` string array for a keyed one).
3. The user puts its `id` into `providerOrder`, or config ships it as a default.
4. `lib/client.js` `KEY_GROUPS` gets one line if it needs a key input in the settings card.

No change to `lib/execute.js` / `lib/router.js`. `test/execute.test.js` proves it: injecting a
fake backend into `createRouter(..., { searchBackends })` and listing its id in
`providerOrder` is enough for it to enter the chain and be called.

### Fetch

The fetch chain is the **same `providerOrder`** as search — this plugin is a router, not a
crawler. Each provider is tried in order, then the local `http` fetcher is appended when
`fetchFallback` is on:

```
providerOrder: [ tavily /extract, exa /contents, firecrawl /v2/scrape, … ] ──> local HTTP
```

Fetch backends are declarative too (`lib/fetch-backends.js`); each entry is
`{id, label, keyRefsField|null, timeoutField, defaultTimeoutMs, keepLastErrorOnUnusable?, run()}`.
`lib/execute.js` loops the chain from `planFetchChain` and dispatches through the registry: a
keyed backend rotates its key pool, a keyless one (`http`) is called once. `run` returns
`{kind:'result', result}` or `{kind:'unusable', reason}` (the backend produced nothing usable —
move to the next provider **without** penalising the key); a thrown error penalises the key.

A provider yields "nothing usable" on exactly these signals (there is no URL whitelist any
more):

1. the request threw (network, timeout, non-2xx);
2. it returned nothing usable:
   - an empty body (Exa / Firecrawl),
   - **Tavily only:** `results` / `raw_content` empty, `failed_results[]` non-empty, or content
     shorter than `minContentChars` (when that is > 0).

Note that Tavily's `/extract` returns **HTTP 200 with an empty `results` array** when every
URL fails. Treating 200 as success would silently produce empty pages, so the response
mapper distinguishes success from failure explicitly.

**Boundary:** whole-site crawling, anti-bot handling, structured extraction and batch jobs are
**not** here — they belong to the firecrawl MCP. This plugin only routes a single-URL
`web_fetch`.

#### Adding a fetch provider

1. Register it in `lib/fetch-backends.js` — `run({apiKey, ctx, request, signal, budgetMs, read, maxBodyChars})`
   returning `{kind:'result', result}` or `{kind:'unusable', reason}`.
2. Add its config fields in `lib/config.js` (a `…ApiKeyRefs` array + a `…TimeoutMs`), all `.volatile()`.
3. Put its `id` into `providerOrder` (shared with search — there is no separate fetch order).
   If it should also serve search, register a search adapter under the same id in
   `lib/search-backends.js`.

### Budget

One fetch has a hard budget (`totalBudgetMs`, default 45 s). Each backend receives
`min(its own timeout, remaining budget)`; when fewer than 2 s remain, no new backend starts
and the error is `WEB_FETCH_BUDGET_EXHAUSTED` rather than a string of timeout messages.

The bundle patch raises `tool-web.fetchTimeoutMs` to 60 s. Without that, the tool layer's
own 30 s default would abort the router mid-chain — the router's budget must be strictly
smaller than the tool's.

## Key handling

`lib/config.js` exposes only reference *names*:

```js
tavilyApiKeyRefs: z.array(z.string()).default(['TAVILY_API_KEY'])
exaApiKeyRefs: z.array(z.string()).default(['EXA_API_KEY'])
firecrawlApiKeyRefs: z.array(z.string()).default(['FIRECRAWL_API_KEY'])
```

Resolution order per reference, in `lib/execute.js`:

1. `ctx.get('credentials').resolve(ref)` — the DSH credentials store
   (`~/.dsh/.credentials.yaml`, 0600, host-enforced);
2. `launchEnvironmentOf(ctx).get(ref).value` — process env, `cwd/.env`, `$DSH_HOME/.env`.

`ctx.get()` rather than `ctx.credentials` because credentials is an optional service: the
plugin must still work when the host has no credentials provider mounted.

### Why refs and not records

`credentials.listRecords()` enumerates **records** (`<scope>/<id>`), never **refs**. So a
pool built from a naming convention (`TAVILY_API_KEY_1..N`) cannot discover its own size —
the plugin would not know how many keys exist. Putting the list in config makes it
enumerable by construction, and keeps every key editable from the host's own settings UI.

### Rotation

`KeyRing` keeps: a cursor, a cooldown map, and a dead set.

- After a success the cursor advances, so consecutive calls do not reuse one key.
- A failure cools the key for `cooldownMs` (default 60 s).
- A failure with 401/403 **and** an explicit "invalid / revoked / expired / deleted" phrase
  marks the key dead for the process lifetime. A bare 401 is not enough — gateways return
  401 for reasons unrelated to the key.

An unresolvable reference (bad syntax, missing value) is treated as *unconfigured*, not as
a failure: it must not penalize the pool.

### Pool lifetime

The pool is created once per router, not once per request. A `RingCache` keyed on
`refs.join("\0") + "\1" + cooldownMs` hands back the same `KeyRing` while that signature is
unchanged, and rebuilds it when the user edits the reference list or the cooldown in the
settings form.

This matters more than it looks: constructing a fresh `KeyRing` inside `search()` /
`fetch()` would reset the cursor, the cooldown map, and the dead set on every call, so every
request would start from the first key. Rotation and cooldown would be dead code that still
passes a single-call test. Two tests now pin it — one asserts the cursor advances across two
calls, the other asserts a key that just failed is skipped by the next call.

## Resolve before decide

Both chains decide their backend list from the **number of keys that actually resolved**,
not from the number of reference names configured. The default reference name always
exists, so name-counting would make `hasTavily` unconditionally true — and then "you never
configured a key" would surface as a string of backend failures instead of one actionable
error. This was caught by the test suite and is the reason `resolvedCandidates()` runs
before `planSearchChain` / `planFetchChain`.

## Error surface

Stable codes, surfaced through the tool's structured error metadata:

| Code | Meaning |
| --- | --- |
| `WEB_SEARCH_ALL_PROVIDERS_FAILED` | every search backend failed |
| `WEB_FETCH_ALL_PROVIDERS_FAILED` | every fetch backend failed |
| `WEB_FETCH_BUDGET_EXHAUSTED` | budget ran out before any backend completed |
| `WEB_INVALID_URL` | bad / over-long / non-http(s) / credential-bearing URL |
| `WEB_ABORTED` | caller cancelled |

`WEB_INVALID_URL` is validated before any network call, matching the host's own fetch
provider's vocabulary so callers do not need two error paths.

## Patch semantics (the silent-failure minefield)

`cordis.patch.yml` targets existing entries by id. `cordis-plugin-include`'s
`applyEntryPatches` assigns `target[key] = value`, so **`config` replaces the whole config
object** — it does not merge. Consequences:

- On `web`, both provider fields must be written together. Omitting one drops it from the
  composed row and reverts that capability to auto-selection, silently.
- On `tool-web`, every needed field must be repeated. Omitting `fetch` disables
  `web_fetch`; omitting `fetchTimeoutMs` reverts to 30 s and cuts the 45 s chain budget.

Also: pinning a provider id that never registers makes every call throw
`WEB_PROVIDER_CONFIGURED_MISSING`. That is why `registerSearchProvider` is the first
effect statement in `apply()` and `registerFetchProvider` is wrapped in `try`.

## Testing

`node --test`, no framework, no build step. 232 tests.

- `test/router.test.js` — data-driven search chain order (`providerOrder`, including
  dedupe and the official fallback), fetch chain order, escalation signals, budget slicing.
  Pure functions, no stubs.
- `test/urls.test.js` — URL validation: length, scheme, embedded credentials, and inputs the
  parser itself rejects (they must still come back as `WEB_INVALID_URL`, not a bare `TypeError`).
- `test/keyring.test.js` — rotation, concurrent claiming, cooldown tiers (rate limit, quota,
  timeout), permanent death, unresolvable refs.
- `test/firecrawl.test.js` — scrape body knobs, response mapping, `metadata.statusCode`
  fallback, upstream failure reasons, and `/v2/search` mapping (highlights, bare-array `data`).
- `test/exa.test.js` — `/search` mapping and search-type normalisation, `/contents` failure
  tags matched by URL rather than position.
- `test/tavily.test.js` — request shape, source mapping, the HTTP-200-is-not-success case,
  server-side timeout and `max_results` clamping.
- `test/rest.test.js` — the shared POST layer: status and `Retry-After` extraction, non-JSON
  bodies, cause preservation, and caller cancellation passing through unwrapped.
- `test/errors.test.js` — `asWebError` never nests an existing `WebError` (its `code` is the
  external contract) and `isAbortError` recognises all three cancellation shapes.
- `test/search-backends.test.js` — registry shape and the official entry's availability
  semantics (a broken endpoint is skipped; a settings read failure is not).
- `test/fetch-backends.test.js` — registry shape, keyed vs keyless split, and the Exa adapter's
  mapping including the empty-body `unusable` path.
- `test/client.test.js` — the browser bundle contract: slot guard, key groups, and the pure
  ordering helpers (toggle, move-before, swap, merge).
- `test/docs.test.js` — both READMEs document exactly the config fields that exist, and every
  error code in `CODES`.
- `test/index.test.js` — assembly constraints: `available()` is always true, a failing fetch
  registration leaves search intact, teardown unregisters both.
- `test/execute.test.js` — degradation: Tavily down → Firecrawl; bad key rolls to the next;
  all down names every backend; no-key-configured is actionable; invalid URL never reaches
  the network; aborted signal never reaches the network; budget exhaustion is distinguished
  from failure.
- `test/execute.test.js` also proves the search registry extension point: a fake backend passed
  via `createRouter(..., { searchBackends })` and named in `providerOrder` enters the
  chain and is called, with no code branch to add. The fetch chain dispatches through its own
  registry the same way, with every pre-registry degradation path preserved exactly.

CI runs on Node 22 and 24, installing host packages from the `next` dist-tag (the `latest`
tag still points at the broken 0.0.1-rc.1 line, which depends on the unpublished
`@deepseek-ai/dsh-environment`).

## Alternatives considered

**Use `dsh-tavily-pool` as-is.** It solves the plaintext-key problem (keys in
`~/.dsh/dsh-tavily-pool/keys.json`, 0600) and has a much richer pool. Rejected because its
fetch provider defaults to disabled (`FETCH_ENABLED_DEFAULT = false`), it has no Firecrawl
escalation, and its ~3000 lines of quota/history machinery are weight the user did not ask
for.

**Reuse `@firecrawl/dsh-firecrawl`.** Rejected: its `peerDependencies` pin DSH
`0.1.0-rc.6`, two release candidates behind the host. Its `lib/fetch.js` implementation was
read and mirrored (request body, response mapping, `assertFetchableUrl` vocabulary), but
the dependency is not taken.

**`!!js process.env.TAVILY_API_KEY` in the patch.** This does keep the literal out of YAML.
Rejected because `!!js` is evaluated with `new Function("ctx","expr", "with (ctx) { return
eval(expr) }")` — full Node privilege in a config file — and because a home-level patch
carrying the same entry makes the host's settings UI refuse to write that entry at all
(`Configuration for "X" is overridden by a home patch or command-line overlay`).

**Regex whitelist.** Rejected in favour of glob: a malformed regex silently fails to match
(users see "the whitelist doesn't work", not "your regex is invalid"), and regex introduces
a ReDoS surface on attacker-influenced URLs.

## Rollback

Point both `web` provider fields back at `deepseek-official` and `http` — both lines
required, per the replacement semantics above — then remove the package. No key material
needs cleanup because none was ever written.
