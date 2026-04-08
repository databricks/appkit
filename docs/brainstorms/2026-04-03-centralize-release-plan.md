---
date: 2026-04-03
topic: centralize-release-plan
---

# Implementation Plan: Secure AppKit Releases

Requirements: [2026-04-03-centralize-release-requirements.md](./2026-04-03-centralize-release-requirements.md)

## Architecture

Two workflows total — `prepare-release` on appkit and a cron workflow on the secure repo:

```
prepare-release (appkit, on push to main):
  version calc → changelog → build → pack → upload artifacts
  (NO commit, NO tag, NO push)

      ↓ secure repo cron polls every 15 min

secure repo cron:
  download → verify SHA256 → scan → publish via OIDC
  → changelog + version bump + commit + tag + push (via GitHub App)
  → GitHub Release (via GitHub App)
  → template sync: npm install + commit + tag + push (via GitHub App)
```

No `finalize-release` workflow on appkit. The secure repo does all post-publish git operations directly via the GitHub App token (which bypasses branch protection on `main`).

### GitHub App Permissions

| Permission | Level | Used for |
|---|---|---|
| `actions` | `read` | List workflow runs, download artifacts |
| `contents` | `write` | Push commits/tags, create releases |

**No `actions: write` needed.** The App must be added to the branch protection bypass list on appkit's `main` branch.

## Part A: Appkit Changes

### A1. `.github/workflows/prepare-release.yml` (new)

Replaces the current `release.yml` release job.

**Triggers:** push to `main` + cron fallback (`*/15 * * * *`).
**Concurrency:** `group: prepare-release, cancel-in-progress: true` — only the latest run survives if multiple PRs merge quickly.

**Steps:**
1. Checkout with full history (`fetch-depth: 0`)
2. Check for releasable commits since last tag → **exit early if none** (handles release commits with `[skip ci]` and cron runs with no new work)
3. Setup pnpm, Node.js, JFrog npm proxy
4. Install dependencies (`pnpm install --frozen-lockfile`)
5. Determine version from conventional commits (e.g., `pnpm exec release-it --release-version --ci` or `conventional-recommended-bump`)
5. Generate changelog diff (e.g., `conventional-changelog -p conventionalcommits`)
6. Sync versions: `tsx tools/sync-versions.ts ${version}`
7. Build: `pnpm build && pnpm --filter=docs build`
8. Dist: `pnpm --filter=@databricks/appkit dist && pnpm --filter=@databricks/appkit-ui dist`
9. SBOM: `pnpm release:sbom`
10. Pack: `npm pack packages/appkit/tmp && npm pack packages/appkit-ui/tmp`
11. Generate SHA256 digests of `.tgz` files
12. Upload artifacts: `.tgz` files, changelog diff, version file, SHA256 digests

**Does NOT:** commit, tag, push, create release, or publish to npm.

### A2. `.github/workflows/release.yml` (modify)

- Remove the release job (replaced by `prepare-release.yml`)
- Remove `sync-template` job (moved to secure repo)
- Keep as a manual `workflow_dispatch` for backward compatibility / dry-run purposes
- Or remove entirely if `prepare-release.yml` fully replaces it

### A3. `.release-it.json` (simplify)

- Keep release-it for version calculation only (`release-it --release-version --ci`)
- Remove all hooks (`before:init`, `after:bump`, `before:release`, `after:release`)
- Remove GitHub release config (`github.release: false`)
- Remove npm config (`npm: false` — already set)
- Alternative: replace release-it entirely with `conventional-recommended-bump` + `conventional-changelog` (evaluate during implementation)

### A4. `.github/workflows/ci.yml` (modify)

Add template dependency pinning lint step:
```yaml
- name: Check template deps are pinned
  run: |
    node -e "
      const pkg = require('./template/package.json');
      const deps = {...pkg.dependencies, ...pkg.devDependencies};
      const unpinned = Object.entries(deps).filter(([,v]) => /^[~^>=*]/.test(v));
      if (unpinned.length) {
        console.error('Unpinned deps:', unpinned.map(([k,v]) => k + '@' + v).join(', '));
        process.exit(1);
      }
    "
```

### A5. Lakebase handling

Lakebase releases are independent (different version, different tag pattern `lakebase-v*`). Two options:
- **Same `prepare-release.yml`** with conditional steps (detect which packages changed via path filters)
- **Separate `prepare-release-lakebase.yml`** triggered on push to `main` with `paths: ['packages/lakebase/**']`

The secure repo workflow already handles both via tag pattern detection (R10). On the appkit side, a separate workflow is cleaner since lakebase has different build commands (`pnpm build:package` in `packages/lakebase/` vs full monorepo build).

### A6. `CLAUDE.md` (modify)

Update the Releasing section to describe the new two-workflow architecture.

## Part B: Secure Repo Changes

**Repo:** `databricks/secure-public-registry-releases-eng`
**Branch:** `pkosiec/appkit-release`
**Depends on:** PR #18 (for `npm-oidc-publish.sh`); worst case fork from that branch

### B1. `.github/workflows/databricks-appkit.yml` (new)

**Triggers:**
- `schedule: '*/15 * * * *'` (cron polling)
- `workflow_dispatch` with `run-id` + `dry-run` inputs (manual fallback)
- `pull_request` on paths `[".github/workflows/databricks-appkit.yml"]` (self-test)

**Jobs:**

**`poll`** (only on schedule):
- Uses `actions/create-github-app-token` to mint App token (`actions: read` on appkit)
- Lists successful `prepare-release` workflow runs on appkit via REST API
- Finds the **latest** completed run
- Checks if tag `v{version}` exists on appkit → skip if yes (already released)
- Checks if a newer `prepare-release` run is in progress → wait/skip (avoid processing stale run)
- Outputs: run ID, version, tag name

**`download-verify`** (needs poll or workflow_dispatch):
- Downloads `.tgz` artifacts from appkit run via REST API (GitHub App token)
- Downloads changelog diff, version, SHA256 digests
- Verifies SHA256 digests match downloaded `.tgz` files
- Uploads verified artifacts as workflow artifacts for downstream jobs

**`scan`** (needs build):
- Downloads workflow artifacts
- Runs `databricks/gh-action-scan` on `.tgz` files

**`publish-appkit`** (needs scan, only for appkit releases):
- Runner: `databricks-release-runner-group-hardened` / `linux-ubuntu-latest-release-hardened`
- Environment: `npm-@databricks/appkit`
- Checkout `_release-scripts` (sparse, for `npm-oidc-publish.sh`)
- Run `npm-oidc-publish.sh` — handle 403 "already exists" as success

**`publish-appkit-ui`** (needs scan, only for appkit releases):
- Environment: `npm-@databricks/appkit-ui`
- Same pattern

**`publish-lakebase`** (needs scan, only for lakebase releases):
- Environment: `npm-@databricks/lakebase`
- Same pattern

**`finalize`** (needs publish jobs):
- Uses `actions/create-github-app-token` (`contents: write` on appkit)
- Checks out appkit at `main` HEAD
- Applies changelog diff to `CHANGELOG.md`
- Bumps versions in `package.json` files
- Builds `NOTICE.md`
- Git commit + tag `v{version}` + push to `main` (App token bypasses branch protection)
- Creates published GitHub Release via REST API

**`template-sync`** (needs finalize):
- Checks out fresh appkit `main` (with release commit)
- Runs `npm install` in `template/` (public npm — packages available immediately)
- Lockfile diff check: abort if unexpected packages changed
- Git commit + tag `template-v{version}` + push via GitHub App

### B2. `CODEOWNERS`

```
# --- @databricks/appkit ---
/.github/workflows/databricks-appkit.yml @databricks/eng-apps-devex
/artifacts/appkit/                       @databricks/eng-apps-devex
```

### B3. Artifacts directories

```
artifacts/appkit/.gitkeep
```

## Part C: Manual Steps (documented, not code)

1. **GitHub App**: Create with `contents: write` + `actions: read` on `databricks/appkit`. Store App ID as variable + private key as secret in secure repo. Add App to branch protection bypass list on appkit's `main`. (Infra team responsibility)
2. **npm Trusted Publishers**: Configure on npmjs.com for each package:
   - `@databricks/appkit` → workflow: `databricks-appkit.yml`, env: `npm-@databricks/appkit`
   - `@databricks/appkit-ui` → workflow: `databricks-appkit.yml`, env: `npm-@databricks/appkit-ui`
   - `@databricks/lakebase` → workflow: `databricks-appkit.yml`, env: `npm-@databricks/lakebase`
3. **Environments**: Request infra team to create environments in secure repo
4. **SHA pins**: All actions must use full SHA pins (conftest policy)

## Key Files Reference

| File | Purpose |
|---|---|
| `.release-it.json` | Current release-it config (may be deprecated) |
| `packages/lakebase/.release-it.json` | Lakebase release-it config |
| `.github/workflows/release.yml` | Current release workflow (to be replaced) |
| `.github/workflows/release-lakebase.yml` | Current lakebase release workflow |
| `.github/actions/setup-jfrog-npm/action.yml` | JFrog OIDC composite action |
| `tools/publish-template-tag.ts` | Template sync script (logic moves to secure repo) |
| `tools/sync-versions.ts` | Version sync across packages |
| `tools/dist-appkit.ts` | Dist package preparation |

## Known Limitations

**Cosmetic commit ordering race:** There is a small window (seconds) between the secure repo's staleness check and the release commit push. If a PR merges during that window, the release commit may appear after the new PR's commit in git history, even though the release doesn't include it. This is purely cosmetic — the published package, changelog, and tag are all correct. A merge queue would eliminate this but is considered unnecessary for the current release frequency.

## Verification

1. **Appkit prepare-release**: Push to `main` → workflow runs, uploads artifacts, does NOT commit/tag/push
2. **Secure repo PR CI**: PR trigger validates workflow syntax, build + scan jobs pass
3. **Secure repo dry-run**: `workflow_dispatch` with `dry-run=true` → full pipeline without actual publish or git push
4. **Full release**: merge PR → prepare-release → cron picks up → scan → publish → changelog + tag + release → template sync
5. **Idempotent retry**: Re-run cron after successful release → tag exists → skipped
6. **Manual fallback**: `workflow_dispatch` with run ID → same pipeline, no cron
7. **Template pinning**: PR with `^` in template deps → CI lint fails
