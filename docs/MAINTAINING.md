# Maintaining: dsh-search-fetch-router

For the next agent taking over this repo. The user-facing docs are `README.zh-CN.md` / `README.md`; the engineering contract lives in `AGENTS.md`.

## At a glance

As of `0.5.0` the plugin is implemented and published (current stable `latest` is `0.5.0`); see `CHANGELOG.md` for what changed when. Search and fetch are both declarative registries (`lib/search-backends.js` + `lib/fetch-backends.js`).

- Repository: `https://github.com/Cyanix-0721/dsh-search-fetch-router`
- Default branch: `main` (track `origin/main`)

## What it does

Takes over both `web_search` and `web_fetch` under provider id `search-fetch-router`, driving search and fetch off one shared `providerOrder` (default `tavily` → `exa` → `firecrawl`; search falls back to host `deepseek-official`, fetch to local `http`). For the full routing model and per-provider endpoints see `README.md` and `docs/ARCHITECTURE.md`; adding a provider is the `README.md` recipe, not repeated here.

Keys never go into any YAML — config stores only credential **reference names**, resolved through the credentials service, then the environment layer.

## Known limitations

- **`unusable` means break**: the keyed fetch loop stops trying the rest of a provider's keys on `unusable`. Intentional — `unusable` is independent of which key was used. If a backend's "unusable" ever becomes per-key (e.g. plan-limited domains), it must throw instead, or the whole backend gets dropped. Commented in code.
- **Cross-origin redirects**: the host `HttpFetchProvider` only follows same-origin hops; `fetchFollowingCrossOrigin` in `lib/fetch-backends.js` follows up to 3 hops, each still via `provider.fetch` (host URL validation is not bypassed).

## Verification status

At `0.5.0`: `npm test` is green (`node --test`, no framework dependency) and `npm run check` (runs `node --check` over `index.js` + every `lib/*.js` via `scripts/check.mjs`) is clean — but run the suite yourself rather than trusting this line. The invariants that can silently break are locked by tests under `test/`: assembly in `test/index.test.js`, the registry-driven chains in `test/execute.search.test.js` / `test/fetch-backends.test.js`, and cache keys in `test/cache.test.js`.

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

## Releasing

Releases are tag-driven and automated (`.github/workflows/publish.yml`). Nothing publishes from a branch push.

```bash
# 1. bump version in package.json + write the CHANGELOG section (the release notes come from it)
# 2. commit, then tag the commit that bump landed on
git tag v0.5.0-beta.0        # or v0.5.0 for a stable release
git push origin v0.5.0-beta.0
```

The workflow then: runs the full CI matrix on the tagged commit (`test.yml` is reused as the gate), checks the
tag equals `package.json`'s version, picks a dist-tag, publishes, and creates the GitHub release
(prerelease flag for prerelease versions).

| version | npm dist-tag | GitHub |
| --- | --- | --- |
| `X.Y.Z` | `latest` | release |
| `X.Y.Z-beta.N` | `beta` | prerelease |
| `X.Y.Z-alpha.N` | `alpha` | prerelease |
| `X.Y.Z-rc.N` / anything else | `next` | prerelease |

**npm auth is OIDC (trusted publishing), not a token.** There is no `NPM_TOKEN` secret to rotate. One-time setup
on npmjs.com → the package → Settings → Trusted Publisher, GitHub Actions:
owner `Cyanix-0721`, repository `dsh-search-fetch-router`, workflow filename `publish.yml` (filename only, must
include `.yml`), **Environment name `npm`** (must match the `environment:` the `publish` job runs under, or the
OIDC exchange is rejected). Requires npm ≥ 11.5.1 on the runner — the workflow checks this and fails early rather
than with a cryptic `ENEEDAUTH`.

**Publishing is gated by a GitHub Environment.** The `publish` job runs in the `npm` environment, so after the
tag build you get a manual approval before anything uploads. Configure it once under repo Settings →
Environments → `npm` → Required reviewers. (This repo already has `npm` set up with a required reviewer.) If a
fork or rename skips this, GitHub auto-creates an unprotected environment of that name, so publishing still works
— just without the gate.

Gotchas:

- Renaming `publish.yml` breaks publishing until the npm setting is updated. The workflow filename is part of the
  trust relationship and cannot be edited on npm — delete and re-create the publisher entry.
- A new trusted publisher must complete its first successful publish within 2 days or it expires.
- `repository.url` in `package.json` must keep matching the GitHub repo (case-sensitive), otherwise provenance
  generation is rejected.
- Prereleases never move `latest`. To promote, publish the corresponding stable version.
- Re-pushing the same tag re-runs the workflow: the npm publish and `gh release` steps are both idempotent, so a
  failure after a successful publish doesn't need a version bump.
- **Never add `registry-url` to `actions/setup-node`.** Giving setup-node a registry URL writes an `.npmrc` line
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`; npm then treats auth as already configured and skips the
  OIDC exchange, so a publish fails with `ENEEDAUTH`/404 even with trusted publishing set up. The default npm
  registry is already npmjs.org, so the input is unnecessary.
- Treat tags as immutable: never force-move or reuse a tag name. The GitHub release is keyed by the tag and the
  `gh release edit` path does not move an existing release's target, so re-pointing a tag leaves the release
  attached to the old commit. To fix a bad release, bump the version and push a new tag.
- After a successful `npm publish` the new version sits in npm's **automated review**: the package page shows it as
  `Validating`, `registry.npmjs.org/<pkg>/<version>` returns 404, and the dist-tag has not moved yet. This is normal
  — wait until it flips to `Published` (then `beta`/`latest` updates itself). Don't re-run the workflow: the same
  version can't be republished (409).

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
