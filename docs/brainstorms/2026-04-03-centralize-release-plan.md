---
date: 2026-04-03
topic: centralize-release-plan
---

# Implementation Plan: Secure AppKit Releases

Requirements: [2026-04-03-centralize-release-requirements.md](./2026-04-03-centralize-release-requirements.md)

## Architecture

Two new workflows — `prepare-release` on appkit and a cron workflow on the secure repo. Additionally, `ci.yml` gets a new lint step, `release.yml` is retired, and lakebase gets a separate `prepare-release-lakebase.yml`.

```
prepare-release (appkit, on push to main):
  actor check → version calc → changelog → build → pack → upload artifacts
  (NO commit, NO tag, NO push)

      ↓ secure repo cron polls every 15 min

secure repo cron:
  actor check (manual only) → download → verify SHA256 (fail-closed) → scan
  → publish via OIDC (id-token: write)
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

**No `actions: write` needed.** The App must be installed with repo-level scope on `databricks/appkit` only (not org-wide) and added to the branch protection bypass list on appkit's `main` branch.

## Part A: Appkit Changes

### A1. `.github/workflows/prepare-release.yml` (new)

Replaces the current `release.yml` release job.

**Triggers:** push to `main` only. No `schedule` trigger — the secure repo already polls on cron, and the `[skip ci]` release commit is handled by the early-exit check.
**Concurrency:** `group: prepare-release, cancel-in-progress: true` — only the latest run survives if multiple PRs merge quickly.

**Steps:**
1. Checkout with full history (`fetch-depth: 0`)
2. Actor authorization check — for `workflow_dispatch`, verify `github.actor` has admin/maintain role; for push triggers, skip (automated)
3. Check for releasable commits since last tag → **exit early if none** (handles release commits with `[skip ci]` and runs with no new work)
4. Setup pnpm, Node.js, JFrog npm proxy
5. Install dependencies (`pnpm install --frozen-lockfile`)
6. Determine version using `conventional-recommended-bump` (preserve path scoping: `["packages/appkit", "packages/appkit-ui", "packages/shared"]`)
7. Generate changelog diff using `conventional-changelog-cli` (same path scoping)
8. Sync versions: `tsx tools/sync-versions.ts ${version}`
9. Build: `pnpm build && pnpm --filter=docs build`
10. Dist: `pnpm --filter=@databricks/appkit dist && pnpm --filter=@databricks/appkit-ui dist`
11. SBOM: `pnpm release:sbom`
12. Pack: `npm pack packages/appkit/tmp && npm pack packages/appkit-ui/tmp`
13. Generate SHA256 digests of `.tgz` files
14. Upload artifacts with `retention-days: 7` and run-scoped names (e.g., `appkit-release-${{ github.run_number }}`): `.tgz` files, changelog diff, version file, SHA256 digests

**Does NOT:** commit, tag, push, create release, or publish to npm.

### A2. `.github/workflows/release.yml` (remove)

Remove entirely — `prepare-release.yml` fully replaces it. Local dry-run is still available via `pnpm release:dry` using the conventional-changelog tooling directly.

### A3. `.release-it.json` (replace)

Replace release-it with `conventional-recommended-bump` + `conventional-changelog-cli`:
- Remove `.release-it.json` and `@release-it/conventional-changelog` dependency
- Add `conventional-recommended-bump` and `conventional-changelog-cli` as devDependencies
- Keep `pnpm release:dry` script working by wiring it to the new tools

**Critical:** The path scoping from current `.release-it.json` (`gitRawCommitsOpts.path: ["packages/appkit", "packages/appkit-ui", "packages/shared"]`) must be preserved when switching to `conventional-recommended-bump`. Pass equivalent path filters to the Bumper API or CLI.

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

### A5. `.github/workflows/prepare-release-lakebase.yml` (new)

Separate workflow for lakebase (cleaner than conditional steps in shared workflow).

**Triggers:** push to `main` with `paths: ['packages/lakebase/**']`.
**Concurrency:** `group: prepare-release-lakebase, cancel-in-progress: true`

**Steps:** Same pattern as A1 but scoped: build only `packages/lakebase`, pack only lakebase `.tgz`, upload with `lakebase-` prefixed artifact names and `retention-days: 7`.

### A6. `CLAUDE.md` (modify)

Update the Releasing section to describe the new architecture.

## Part B: Secure Repo Changes

**Repo:** `databricks/secure-public-registry-releases-eng`
**Branch:** `pkosiec/appkit-release`
**Depends on:** PR #18 (for `npm-oidc-publish.sh`); worst case fork from that branch

### B1. `.github/workflows/databricks-appkit.yml` (new)

**Triggers:**
- `schedule: '*/15 * * * *'` (cron polling)
- `workflow_dispatch` with `run-id` + `dry-run` inputs (manual fallback)
- `pull_request` on paths `[".github/workflows/databricks-appkit.yml"]` (self-test)

**On failure:** GitHub Actions sends failure notifications to repository watchers. Optionally add a Slack webhook step for the `@databricks/eng-apps-devex` channel on scan or publish failure.

**Jobs:**

**`poll`** (only on schedule — skipped for `workflow_dispatch` and `pull_request`):
- Uses `actions/create-github-app-token` to mint App token (`actions: read` on appkit)
- Lists successful `prepare-release` workflow runs on appkit via REST API
- Identifies release stream from the source workflow name: `prepare-release` → appkit release, `prepare-release-lakebase` → lakebase release. Uses this to determine which publish jobs to run and which tag pattern to check.
- Finds the **latest** completed run
- Checks if tag `v{version}` exists on appkit → skip if yes (already released)
- Checks if a newer `prepare-release` run is in progress → wait/skip (avoid processing stale run)
- Outputs: run ID, version, tag name, release stream

**`actor-check`** (only on `workflow_dispatch`):
- Verifies `github.actor` has admin/maintain role on the secure repo (per SOP)
- Skipped for `schedule` and `pull_request` triggers (automated, no actor to check)

**`download-verify`** (needs poll or workflow_dispatch):
- Downloads `.tgz` artifacts from appkit run via REST API (GitHub App token)
- Downloads changelog diff, version, SHA256 digests
- Verifies SHA256 digests match downloaded `.tgz` files — **fail-closed**: any mismatch or error aborts the pipeline immediately; no `continue-on-error` or bypass path
- Uploads verified artifacts as workflow artifacts for downstream jobs

**`scan`** (needs download-verify):
- Downloads workflow artifacts
- Runs `databricks/gh-action-scan` on `.tgz` files

**`publish-appkit`** (needs scan, only for appkit releases):
- Runner: `databricks-release-runner-group-hardened` / `linux-ubuntu-latest-release-hardened`
- Environment: `npm-@databricks/appkit`
- **Permissions:** `id-token: write` (required for OIDC Trusted Publishing)
- Checkout `_release-scripts` (sparse, for `npm-oidc-publish.sh`)
- Run `npm-oidc-publish.sh` — handle 403 "already exists" as success

**`publish-appkit-ui`** (needs scan, only for appkit releases):
- Environment: `npm-@databricks/appkit-ui`
- **Permissions:** `id-token: write`
- Same pattern

**`publish-lakebase`** (needs scan, only for lakebase releases):
- Environment: `npm-@databricks/lakebase`
- **Permissions:** `id-token: write`
- Same pattern

**`finalize`** (needs publish jobs):
- Uses `actions/create-github-app-token` (`contents: write` on appkit)
- Checks out appkit at `main` HEAD
- Applies changelog diff to `CHANGELOG.md`
- Bumps versions in `package.json` files
- Builds `NOTICE.md`
- Git commit + tag `v{version}` + push to `main` (App token bypasses branch protection)
- Creates published GitHub Release via REST API

**`template-sync`** (needs finalize, appkit releases only):
- Checks out fresh appkit `main` (with release commit)
- Runs `npm install` in `template/` (public npm — packages available immediately)
- Lockfile diff check: abort if unexpected packages changed
- Git commit + tag `template-v{version}` + push via GitHub App

#### Mode-switching conditional logic

```yaml
# Conditional logic in databricks-appkit.yml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:
    inputs:
      run-id:
        description: 'Appkit prepare-release workflow run ID'
        required: true
        type: string
      dry-run:
        description: 'Dry run (validate without publishing)'
        required: false
        type: boolean
        default: false
  pull_request:
    paths: ['.github/workflows/databricks-appkit.yml']

jobs:
  poll:
    if: github.event_name == 'schedule'
    # Discovers run-id, version, tag, stream from API
    # Skipped entirely for workflow_dispatch and pull_request
    outputs:
      run-id: ${{ steps.find-run.outputs.run-id }}
      version: ${{ steps.find-run.outputs.version }}
      tag: ${{ steps.find-run.outputs.tag }}
      stream: ${{ steps.find-run.outputs.stream }}

  download-verify:
    needs: [poll]
    if: always() && (needs.poll.result == 'success' || github.event_name == 'workflow_dispatch')
    # Uses poll outputs (cron) OR workflow_dispatch inputs (manual)
    env:
      RUN_ID: ${{ needs.poll.outputs.run-id || inputs.run-id }}

  scan:
    needs: [download-verify]
    # Runs after successful download-verify

  publish-appkit:
    needs: [scan]
    if: needs.scan.result == 'success' && inputs.dry-run != true
    # Skipped in dry-run mode; inputs context preserves boolean type

  finalize:
    needs: [publish-appkit, publish-appkit-ui]
    if: needs.publish-appkit.result == 'success' && inputs.dry-run != true

  template-sync:
    needs: [finalize]
    if: needs.finalize.result == 'success' && inputs.dry-run != true
```

**Key points:**
- `poll` runs only on `schedule` — skipped entirely for `workflow_dispatch` and `pull_request`
- `download-verify` accepts run ID from either source via `needs.poll.outputs.run-id || inputs.run-id`
- `inputs.dry-run` (not `github.event.inputs.dry-run`) preserves the boolean type for clean conditionals
- `dry-run` gates publish/finalize/template-sync — allows full pipeline validation without side effects
- `pull_request` trigger runs only `download-verify` + `scan` (self-test, no publish)

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

1. **GitHub App**: Create with `contents: write` + `actions: read` on `databricks/appkit`. Install with repo-level scope on `databricks/appkit` only (not org-wide). Store App ID as variable + private key as encrypted secret in secure repo. Add App to branch protection bypass list on appkit's `main`. Establish annual key rotation schedule (≤365 days). (Infra team responsibility)
2. **npm Trusted Publishers**: Configure on npmjs.com for each package with OIDC subject claim pinned to exact repo, workflow, and environment:
   - `@databricks/appkit` → repo: `secure-public-registry-releases-eng`, workflow: `databricks-appkit.yml`, env: `npm-@databricks/appkit`
   - `@databricks/appkit-ui` → repo: `secure-public-registry-releases-eng`, workflow: `databricks-appkit.yml`, env: `npm-@databricks/appkit-ui`
   - `@databricks/lakebase` → repo: `secure-public-registry-releases-eng`, workflow: `databricks-appkit.yml`, env: `npm-@databricks/lakebase`
3. **Environments**: Request infra team to create environments in secure repo
4. **SHA pins**: All actions must use full SHA pins (conftest policy)
5. **Audit logging**: GitHub audit log covers App activity and workflow runs natively. npm audit log covers package publishing. Verify audit log streaming is enabled for the org. Document audit log locations in the runbook.
6. **Monitoring**: Configure GitHub Actions failure notifications for the secure repo workflow. Verify npm package audit alerts are enabled for `@databricks/appkit*` and `@databricks/lakebase`.
7. **Decommissioning runbook**: Document procedure to revoke App installation on `databricks/appkit`, remove Trusted Publisher configs for all three packages, and delete secrets from secure repo. Store in secure repo README.

## Commit Ordering and Race Condition Prevention

**Problem:** If `prepare-release` triggers on every push to `main`, multiple PR merges can create stale runs (wrong version/changelog baked into artifacts).

**Solution:** Push trigger + concurrency cancel + early exit.

```yaml
# prepare-release on appkit
on:
  push:
    branches: [main]
concurrency:
  group: prepare-release
  cancel-in-progress: true
```

1. **Push trigger** fires on PR merge (fast feedback)
2. **`cancel-in-progress: true`** → if another push arrives while running, old run cancelled — only latest survives
3. **Early exit** → first step checks for releasable commits since last tag; exits if none

**Scenario:**
```
t=0:  PR1 merged (commit A) → prepare-release starts
t=3:  PR2 merged (commit B) → cancels run at A, starts new run at B
t=8:  prepare-release at B completes → artifacts uploaded (v0.22.0, includes PR1+PR2)
t=10: secure repo processes → publishes v0.22.0 → pushes release commit C [skip ci]
t=15: cron fires on secure repo → no new prepare-release runs → exits early
t=20: PR3 merged (commit D) → prepare-release fires → v0.22.1 with PR3 only
```

**Secure repo also checks:**
- Tag `v{version}` exists → skip (already released)
- Is there a newer `prepare-release` run in progress? → wait
- Processes only the latest completed `prepare-release` run

**Known limitation — cosmetic commit ordering:** There is a small race window (seconds) between the secure repo's staleness check and the release commit push. If a PR merges during that window, the release commit may appear after the new PR's commit in git history, even though the release doesn't include it. This is purely cosmetic — the published package, changelog, and tag are all correct. A merge queue would eliminate this but is considered unnecessary for the current release frequency.

## Reliability Guarantees

- **Source of truth**: Git tag on appkit. Tag exists = fully processed. No tag = needs processing (retry).
- **Idempotent pipeline**: If publish succeeds but git push fails, next cron retry will:
  - Re-scan (same artifacts, passes again)
  - npm publish returns 403 "already exists" → treated as success
  - Git push succeeds → tag created → done
- **Ordering**: Secure repo processes only the latest `prepare-release` run. `cancel-in-progress` ensures only one run completes per batch of merges.
- **Changelog continuity**: `conventional-changelog` always diffs from the latest tag, so each `prepare-release` generates the correct diff regardless of timing.
- **No stale releases**: Concurrency cancellation + early exit ensure version/changelog are always computed from the current state of `main`.

## Key Files Reference

| File | Purpose |
|---|---|
| `.release-it.json` | Current release-it config (to be replaced with conventional-changelog tools) |
| `packages/lakebase/.release-it.json` | Lakebase release-it config |
| `.github/workflows/release.yml` | Current release workflow (to be removed) |
| `.github/workflows/release-lakebase.yml` | Current lakebase release workflow |
| `.github/actions/setup-jfrog-npm/action.yml` | JFrog OIDC composite action |
| `tools/publish-template-tag.ts` | Template sync script (logic moves to secure repo) |
| `tools/sync-versions.ts` | Version sync across packages |
| `tools/dist-appkit.ts` | Dist package preparation |

## Verification

1. **Appkit prepare-release**: Push to `main` → workflow runs, uploads artifacts, does NOT commit/tag/push
2. **Secure repo PR CI**: PR trigger validates workflow syntax, build + scan jobs pass
3. **Secure repo dry-run**: `workflow_dispatch` with `dry-run=true` → full pipeline without actual publish or git push
4. **Full release**: merge PR → prepare-release → cron picks up → scan → publish → changelog + tag + release → template sync
5. **Idempotent retry**: Re-run cron after successful release → tag exists → skipped
6. **Manual fallback**: `workflow_dispatch` with run ID → same pipeline, no cron
7. **Template pinning**: PR with `^` in template deps → CI lint fails
8. **Implementation match**: Before rollout, verify deployed pipeline matches this plan and ESI-4424 requirements. Any material change to GitHub App permissions, OIDC configuration, or publishing script requires new EntSec review.
