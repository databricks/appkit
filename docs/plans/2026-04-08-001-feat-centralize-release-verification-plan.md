---
title: "feat: Verify Secure AppKit Release Plan Against Requirements"
type: feat
status: active
date: 2026-04-08
origin: docs/brainstorms/2026-04-03-centralize-release-requirements.md
---

# Verification: Secure AppKit Release Plan

## Overview

This document verifies the implementation plan (`docs/brainstorms/2026-04-03-centralize-release-plan.md`) against the requirements (`docs/brainstorms/2026-04-03-centralize-release-requirements.md`), validates GitHub Actions syntax, checks alignment with existing secure repo patterns, and identifies gaps that need resolution before implementation.

**Target repos:**
- `databricks/appkit` (public) — prepare-release workflows
- `databricks/secure-public-registry-releases-eng` (private) — cron + publish workflow

## Requirements Trace Verification

### Fully Covered Requirements

| Req | Summary | Plan Coverage |
|-----|---------|---------------|
| R1 | Push to main + concurrency + early exit | A1 — correct syntax per GitHub Actions docs |
| R2 | Version from conventional commits, no commit/tag | A1 step 6, A3 |
| R3 | Changelog diff as artifact | A1 step 7 + step 14 |
| R4 | Sync versions, build, dist, SBOM, pack | A1 steps 8-12 |
| R5 | Upload artifacts with retention + run-scoped names | A1 step 14 — validated: upload-artifact v4 requires unique names |
| R6 | No commit/tag/push/release | A1 explicitly states this |
| R7 | Explicit retention + run-scoped names | A1 step 14 |
| R8 | Cron every 15 min + GitHub App token | B1 poll job |
| R9 | Tag check for idempotency | B1 poll job |
| R10 | Distinguish release streams by workflow name | B1 poll job |
| R11 | SHA256 verification, fail-closed | B1 download-verify job |
| R12 | Security scan before publish | B1 scan job |
| R13 | OIDC Trusted Publishing via npm-oidc-publish.sh | B1 publish jobs — confirmed script exists and works per-package |
| R14 | Changelog + version bump + commit + tag + push via App | B1 finalize job |
| R15 | GitHub Release via App | B1 finalize job |
| R16 | Template sync with public npm | B1 template-sync job |
| R17 | npm 403 as success | B1 publish jobs — mentioned but not detailed |
| R18 | Failure notifications | B1 — "On failure" section |
| R19 | workflow_dispatch with manual run ID | B1 — actor-check + mode-switching logic |
| R20 | Actor authorization check | B1 actor-check job + A1 step 2 |
| R21-R26 | GitHub App requirements | Part C — documented as manual steps |
| R27-R28 | npm Trusted Publisher + environments | Part C |
| R29 | CODEOWNERS | B2 |
| R30 | Artifacts directory | B3 |
| R31 | SHA-pinned actions | Part C step 4 — **see gap below** |
| R32 | SHA256 verification | B1 download-verify |
| R33 | Audit logging | Part C step 5 |
| R34 | Monitoring/alerting | Part C step 6 |
| R35 | Rollback procedures | Part C step 7 |
| R36 | Decommissioning procedure | Part C step 7 |
| R37 | Per-workflow environments | B1 publish jobs use separate environments |
| R38 | Exact version deps in template | Current state already correct |
| R39 | CI lint for pinned deps | A4 |
| R40 | Lockfile diff check in template sync | B1 template-sync — **see gap below** |
| R41 | workflow_dispatch with run-id + dry-run | B1 mode-switching logic |
| R42 | Full pipeline in manual mode | B1 — same pipeline, different run ID source |
| R43 | Transition from manual to automated | B1 — enable cron trigger |

### Requirements with Gaps or Issues

None of the 43 requirements are missing from the plan. However, several have **implementation detail gaps** documented below.

## Syntax Validation (via context7 docs)

### GitHub Actions Syntax — Validated Correct

1. **Concurrency with cancel-in-progress** (A1):
   ```yaml
   concurrency:
     group: prepare-release
     cancel-in-progress: true
   ```
   Confirmed valid per GitHub Actions docs. `cancel-in-progress: true` cancels the running job when a new one queues in the same group.

2. **workflow_dispatch inputs** (B1):
   ```yaml
   workflow_dispatch:
     inputs:
       run-id:
         required: true
         type: string
       dry-run:
         required: false
         type: boolean
         default: false
   ```
   Confirmed valid. `inputs.dry-run` preserves boolean type (vs `github.event.inputs.dry-run` which stringifies). Plan correctly uses `inputs.dry-run`.

3. **Schedule cron** (B1):
   ```yaml
   schedule:
     - cron: '*/15 * * * *'
   ```
   Valid cron syntax for "every 15 minutes".

4. **Job conditionals with needs** (B1):
   ```yaml
   download-verify:
     needs: [poll]
     if: always() && (needs.poll.result == 'success' || github.event_name == 'workflow_dispatch')
   ```
   Confirmed valid. `always()` is needed because `poll` is skipped on `workflow_dispatch` (skipped jobs have result `skipped`, which would block dependent jobs without `always()`).

5. **Permissions id-token: write** (B1 publish jobs):
   Confirmed valid per GitHub Actions docs. Required for OIDC token fetch.

6. **upload-artifact v4 immutability** (A1):
   Plan correctly handles this with run-scoped names (`appkit-release-${{ github.run_number }}`). Confirmed: v4 artifacts are immutable by default; unique names are the correct approach.

7. **pull_request self-test trigger** (B1):
   ```yaml
   pull_request:
     paths: ['.github/workflows/databricks-appkit.yml']
   ```
   Valid syntax. On PR, only download-verify + scan run (no publish).

### GitHub Actions Syntax — Issues Found

8. **Dry-run conditional on publish jobs** (B1):
   ```yaml
   publish-appkit:
     needs: [scan]
     if: needs.scan.result == 'success' && inputs.dry-run != true
   ```
   **Issue:** On `schedule` trigger, `inputs` context is empty (no `workflow_dispatch` inputs). `inputs.dry-run` evaluates to `''` (empty string), and `'' != true` is `true`, so publish would still run. This is **correct behavior** (cron should publish), but the plan should explicitly document this reasoning to avoid confusion during implementation.

9. **Finalize conditional** (B1):
   ```yaml
   finalize:
     needs: [publish-appkit, publish-appkit-ui]
     if: needs.publish-appkit.result == 'success' && inputs.dry-run != true
   ```
   **Issue:** If only lakebase is being released, `publish-appkit` is skipped, so `needs.publish-appkit.result` would be `skipped`. The conditional should account for the release stream. Consider:
   ```yaml
   if: |
     (needs.publish-appkit.result == 'success' || needs.publish-lakebase.result == 'success') &&
     inputs.dry-run != true
   ```

## Gaps and Issues

### Gap 1: conventional-changelog-cli Multiple Path Filtering (HIGH)

**Problem:** The plan (A3) says to replace release-it with `conventional-recommended-bump` + `conventional-changelog-cli`. However, the CLI's `--commit-path` flag has **limited support for multiple paths**. The current `.release-it.json` uses:

```json
"gitRawCommitsOpts": {
  "path": ["packages/appkit", "packages/appkit-ui", "packages/shared"]
}
```

The **programmatic API** (`Bumper` class, `GitLogParams.path`) accepts `string[]` and works correctly. But the **CLI** (`conventional-changelog -p conventionalcommits --commit-path=...`) may not accept multiple paths cleanly.

**Recommendation:** Instead of using the CLI, create a small Node.js script (`tools/release-version.ts` and `tools/release-changelog.ts`) that uses the programmatic API with path filtering. This gives full control and avoids CLI limitations. The `pnpm release:dry` script can invoke these directly.

### Gap 2: Finalize Job Requires Full Monorepo Setup (MEDIUM)

**Problem:** The finalize job (B1) needs to:
1. Apply changelog diff → simple file operation
2. Bump versions in package.json files → could use `jq` or `node -e`
3. **Build NOTICE.md** → requires `pnpm build:notice` which runs `tsx tools/build-notice.ts` and needs the full dependency tree

Running `pnpm install` + `build:notice` in the secure repo on a checkout of appkit adds significant complexity and build time.

**Recommendation:** Generate `NOTICE.md` during `prepare-release` on appkit and upload it as an artifact alongside the `.tgz` files. The finalize job then simply copies it into place. This keeps the secure repo lightweight (no need for pnpm/node ecosystem setup beyond basic operations).

### Gap 3: Secure Repo Pattern Deviation (MEDIUM)

**Problem:** The secure repo has established patterns:
- **Reusable workflows** (`_release-*.yml`) called by per-package workflows
- **Build in secure repo** from source checkout, then scan, then publish
- The appkit plan proposes a **different pattern**: artifacts built in appkit, downloaded in secure repo, then scan + publish

The `databricks-cli.yml` workflow is the closest match (downloads artifacts from another repo), but the appkit plan is significantly more complex with its poll+finalize+template-sync jobs.

**Assessment:** This deviation is **justified** because:
- The build must happen in appkit (it uses pnpm monorepo, custom tooling, JFrog proxy)
- The poll pattern is required since appkit can't trigger workflows on the private repo
- Finalize + template-sync are unique to appkit's release flow

**Recommendation:** Document the pattern deviation in the PR description. Consider creating a reusable composite action or shared script for the download-verify-scan sequence that could be extracted later.

### Gap 4: download-artifact.sh SHA256 Scope Mismatch (MEDIUM)

**Problem:** The existing `download-artifact.sh` in the secure repo expects the SHA256 digest as a CLI parameter (computed externally). But in the appkit plan, the digests are **uploaded as part of the artifacts themselves** — the secure repo downloads the artifact zip, then extracts it, then verifies the `.tgz` files inside against the digest file.

This means we can't directly reuse `download-artifact.sh`. We need a different verification flow:
1. Download the artifact zip via GitHub REST API
2. Extract the zip
3. Read the SHA256 digest file from the extracted contents
4. Verify each `.tgz` file against the digest

**Recommendation:** Create a new script `download-verify-appkit.sh` (or inline the logic in the workflow) that handles this two-stage verification. The existing `download-artifact.sh` is designed for a different flow (digest provided upfront).

### Gap 5: npm 403 Handling Not Detailed (LOW)

**Problem:** R17 requires handling npm 403 "already exists" as success. The plan mentions this but doesn't specify how. The `npm-oidc-publish.sh` script doesn't currently handle this — it will exit non-zero on 403.

**Recommendation:** Add a wrapper or post-step that catches the 403 exit code:
```bash
npm-oidc-publish.sh dist/*.tgz || {
  if npm view @databricks/appkit@${VERSION} version 2>/dev/null; then
    echo "Package already published, treating as success"
    exit 0
  fi
  exit 1
}
```

### Gap 6: SHA-Pinned Action References Missing (LOW)

**Problem:** R31 requires SHA-pinned actions. The plan references actions by name but doesn't list the SHAs. For implementation, we need the exact SHAs used in the secure repo.

**Current SHAs from secure repo (to reuse):**
- `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd` (v6.0.2)
- `actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f` (v7.0.0)
- `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093` (v4.3.0)
- `actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f` (v6.3.0)
- `actions/create-github-app-token@f8d387b68d61c58ab83c6c016672934102569859` (v3.0.0)
- `databricks/gh-action-scan@bc436612536af6dba6679ef5c9fb40bbe8e83c1f` (main)
- `pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320` (v5.0.0)

### Gap 7: Lockfile Diff Check Implementation (LOW)

**Problem:** R40 requires verifying only `@databricks/appkit` and `@databricks/appkit-ui` changed in the lockfile during template sync. The plan mentions this but doesn't specify how.

**Recommendation:** Compare `package-lock.json` before and after `npm install`:
```bash
cp package-lock.json package-lock.json.before
npm install
diff <(jq '.packages | keys[]' package-lock.json.before | sort) \
     <(jq '.packages | keys[]' package-lock.json | sort) | \
  grep '^[<>]' | grep -v '@databricks/appkit' && {
    echo "ERROR: Unexpected packages changed"; exit 1;
  }
```

### Gap 8: Lakebase Release Stream in Single Workflow (LOW)

**Problem:** The plan has one `databricks-appkit.yml` workflow handling both appkit and lakebase releases. The poll job identifies the stream from the source workflow name. But the conditional logic for running different publish jobs based on stream isn't fully specified in the YAML snippet.

**Recommendation:** Add stream-based conditionals:
```yaml
publish-appkit:
  if: needs.download-verify.outputs.stream == 'appkit' && ...
publish-lakebase:
  if: needs.download-verify.outputs.stream == 'lakebase' && ...
finalize:
  needs: [publish-appkit, publish-appkit-ui, publish-lakebase]
  if: |
    always() &&
    (needs.publish-appkit.result == 'success' || needs.publish-lakebase.result == 'success') &&
    !contains(needs.*.result, 'failure') && inputs.dry-run != true
```

### Gap 9: Pull Request Self-Test Scope (LOW)

**Problem:** The plan says `pull_request` trigger runs `download-verify` + `scan`. But `download-verify` needs a real `run-id` to download artifacts from. On a PR, there's no run ID available.

**Recommendation:** On `pull_request`, run a **syntax validation / dry-run only** — skip `download-verify` and `scan` (they need real artifacts). Or use a fixed test artifact for PR validation. The existing npm template workflows in the secure repo gate publish on `github.event_name == 'workflow_dispatch'` and run build+scan on PR — but they build from source, not from external artifacts.

## Secure Repo: Existing Assets to Leverage

The `pkosiec/appkit-release` branch is currently identical to `main` — clean starting point.

**Scripts we can reuse directly:**
- `npm-oidc-publish.sh` — handles OIDC token exchange + npm publish per-package (introduced in PR #18)
- `jfrog-oidc-token.sh` + `configure-npm.sh` — JFrog proxy setup for npm installs
- `download-artifact.sh` — downloads + SHA256 verifies artifacts from another repo's workflow run (introduced in PR #30). **However**, its interface expects the digest as a CLI parameter, not as a file inside the artifact. See Gap 4.

**Workflows to use as templates:**
- `databricks-cli.yml` (PR #30) — **closest match** to our needs: cross-repo artifact download via `download-artifact.sh`, SHA256 verification, GitHub App token via `actions/create-github-app-token`, separate publish environments. Key differences: cli uses `workflow_dispatch` only (no cron poll), publishes to GitHub Releases + PyPI (not npm).
- `_release-databricks-ai-bridge-npm.yml` — canonical npm publish pattern: build → scan → publish with `npm-oidc-publish.sh`, per-package environments, hardened runners. Our publish jobs should follow this exact structure.

**SHA-pinned action versions already in use (reuse these):**
- `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd` (v6.0.2)
- `actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f` (v7.0.0)
- `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093` (v4.3.0)
- `actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f` (v6.3.0)
- `actions/create-github-app-token@f8d387b68d61c58ab83c6c016672934102569859` (v3.0.0)
- `databricks/gh-action-scan@bc436612536af6dba6679ef5c9fb40bbe8e83c1f` (main)
- `pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320` (v5.0.0)

**Runner groups (from PR #28 syntax):**
- Build/scan: `group: databricks-protected-runner-group, labels: linux-ubuntu-latest`
- Publish: `group: databricks-release-runner-group-hardened, labels: linux-ubuntu-latest-release-hardened`

## Alignment with Secure Repo Conventions

| Convention | Status | Notes |
|-----------|--------|-------|
| SHA-pinned actions | Plan mentions (R31) | Need to use exact SHAs from secure repo |
| Hardened runners for publish | Correct | `databricks-release-runner-group-hardened` |
| Protected runners for build/scan | Correct | `databricks-protected-runner-group` |
| Per-package GitHub environments | Correct | `npm-@databricks/appkit`, etc. |
| CODEOWNERS entry | Correct | B2 |
| `id-token: write` for OIDC | Correct | Confirmed required |
| `npm-oidc-publish.sh` usage | Correct | One invocation per package, per environment |
| Artifact directory gitkeep | Correct | B3 |
| Default shell: bash | Not specified | Add `defaults: run: shell: bash` |

## Summary of Required Changes to Plan

### Must Fix Before Implementation

1. **Gap 1 (HIGH):** Replace `conventional-changelog-cli` approach with programmatic Node.js scripts for version calculation and changelog generation with multi-path support
2. **Gap 9 (now HIGH on reflection):** Clarify what `pull_request` trigger actually validates — it can't download external artifacts

### Should Fix

3. **Gap 2:** Generate NOTICE.md in prepare-release, upload as artifact — avoid full monorepo setup in secure repo finalize job
4. **Gap 4:** Document that a new download-verify script is needed (can't reuse `download-artifact.sh` directly)
5. **Syntax Issue 9:** Fix finalize job conditional to handle lakebase-only releases
6. **Gap 8:** Add stream-based conditionals to publish/finalize jobs

### Nice to Have

7. **Gap 5:** Document npm 403 handling approach
8. **Gap 6:** List SHA-pinned action references
9. **Gap 7:** Specify lockfile diff check implementation
10. Add `defaults: run: shell: bash` to match secure repo convention

## Verification Checklist

- [x] All 43 requirements traced to plan sections
- [x] No requirements missing from plan
- [x] GitHub Actions syntax validated via context7 docs
- [x] upload-artifact v4 immutability handled correctly
- [x] OIDC permissions correct (`id-token: write`)
- [x] Concurrency + cancel-in-progress syntax correct
- [x] workflow_dispatch inputs with boolean type correct
- [x] Secure repo conventions checked (runners, environments, SHA pins)
- [x] Existing scripts reviewed (`npm-oidc-publish.sh`, `download-artifact.sh`)
- [x] conventional-changelog path filtering limitation identified
- [x] Cross-repo interaction pattern validated against `databricks-cli.yml`
