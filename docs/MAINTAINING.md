# Maintaining: dsh-search-fetch-router

For the next agent taking over this repo. The user-facing docs are `README.zh-CN.md` / `README.md`; the engineering contract lives in `AGENTS.md`.

## At a glance

As of `0.4.0` the plugin is implemented and published; see `CHANGELOG.md` for what changed when. Search and fetch are both declarative registries (`lib/search-backends.js` + `lib/fetch-backends.js`).

- Repository: `https://github.com/Cyanix-0721/dsh-search-fetch-router`
- Default branch: `main` (track `origin/main`)

## What it does

Takes over both `web_search` and `web_fetch` under provider id `search-fetch-router`, driving search and fetch off one shared `providerOrder` (default `tavily` → `exa` → `firecrawl`; search falls back to host `deepseek-official`, fetch to local `http`). For the full routing model and per-provider endpoints see `README.md` and `docs/ARCHITECTURE.md`; adding a provider is the `README.md` recipe, not repeated here.

Keys never go into any YAML — config stores only credential **reference names**, resolved through the credentials service, then the environment layer.

## Known limitations

- **`unusable` means break**: the keyed fetch loop stops trying the rest of a provider's keys on `unusable`. Intentional — `unusable` is independent of which key was used. If a backend's "unusable" ever becomes per-key (e.g. plan-limited domains), it must throw instead, or the whole backend gets dropped. Commented in code.
- **Cross-origin redirects**: the host `HttpFetchProvider` only follows same-origin hops; `fetchFollowingCrossOrigin` in `lib/fetch-backends.js` follows up to 3 hops, each still via `provider.fetch` (host URL validation is not bypassed).

## Verification status

At `0.4.0`: `npm test` is green (`node --test`, no framework dependency) and `node --check` is clean on every source file — but run the suite yourself rather than trusting this line. The invariants that can silently break are locked by tests under `test/`: assembly in `test/index.test.js`, the registry-driven chains in `test/execute.search.test.js` / `test/fetch-backends.test.js`, and cache keys in `test/cache.test.js`.

Not yet verified / next-stage:

- Per-backend attribution is only visible via debug logs (`note()` in `lib/execute.js`); the logger's debug level may be off — an observation point, not a routing effect.
- Whether `~/.dsh/.credentials.yaml` already holds `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` cannot be checked by an agent (the file is protected by `secret.deny-path`). Missing keys fall back to official search / local http.

## Installing / uninstalling into a profile

```bash
# install (local checkout, link dependency; auto-appends to dsh.profile.bundles)
dsh plugin --profile web add /path/to/dsh-search-fetch-router

# uninstall (after pnpm remove, also delete the "dsh-search-fetch-router" line from
# dsh.profile.bundles in ~/.dsh/profiles/web/package.json)
dsh plugin --profile web remove dsh-search-fetch-router
```

Rollback: back up `package.json`, `pnpm-lock.yaml`, `cordis.patch.yml` before installing, restore them and `pnpm install` to revert.

## Hard constraints (read before changing code)

`AGENTS.md` is the authoritative list — read it before touching code, and don't re-copy it here (a hard-coded "fifteen" in this very file drifted to sixteen). The four that bite most often: a pinned provider must always report `available()` `true`; `registerSearchProvider` must be the first failable effect in `apply()`; id-targeted `config` replaces the whole block, so write both `web` provider fields together; `tool-web.*TimeoutMs` must be ≥ the matching budget. Details and the rest are in `AGENTS.md`.

## Running tests locally

`node_modules/@deepseek-ai/*` are symlinks into the DSH install, for local resolution only, not committed:

```bash
npm test
# or, in a sandbox that blocks the npm wrapper's child pipes:
node --test --test-isolation=none "test/*.test.js"
```

Rebuild the symlinks if they break (the DSH install path may change with the npx cache):

```bash
DSH_INSTALL=/path/to/node_modules/@deepseek-ai   # adjust to your install
for p in schemastery cordis dsh-web dsh-credentials dsh-launch-environment \
         dsh-settings dsh-web-fetch-http dsh-web-search-deepseek dsh-llm dsh-tools cosmokit; do
  ln -sfn "$DSH_INSTALL/$p" "node_modules/@deepseek-ai/$p"
done
```

## Environment gotchas

- `~/.dsh/...` sits outside the default workspace-write sandbox; installing a plugin needs `danger-full-access`.
- WSL-side SSH auth may be unavailable (`Permission denied (publickey)`); push over HTTPS with `gh auth setup-git` rather than writing a token into the URL.
- On npm, `@deepseek-ai/*` **`latest` points at a broken `0.0.1-rc.1`** (depends on the unpublished `@deepseek-ai/dsh-environment`, E404). **Use the `next` tag.**
- `npm pack` / `npx` may fail with `EROFS` if the npm cache is read-only; pass `--cache "$(pwd)/.tmp-npm-cache"`.
- `~/.dsh/.credentials.yaml` is protected by `secret.deny-path` even under `danger-full-access`; key entry/confirmation is the user's job.
- DSH does **not** redact tool output: `grep` echoes and `cat` contents land verbatim in session logs. For secret-like content use `grep -c` / `grep -l`, never echo matching lines.

## Related docs

- Design decisions and rationale: `docs/superpowers/specs/2026-11-10-dsh-search-fetch-router-design.md`
- Architecture / mental model: `docs/ARCHITECTURE.md`
- Engineering contract: `AGENTS.md`
- User-facing: `README.zh-CN.md`
