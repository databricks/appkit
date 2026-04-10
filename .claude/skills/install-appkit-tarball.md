---
name: install-appkit-tarball
description: "Install appkit tgz builds into a project. Downloads from the prepare-release CI workflow (default) or builds locally. Use when testing appkit release candidates, installing pre-release appkit, or when user says 'install appkit tarball', 'install local appkit', 'use local appkit', 'link appkit tgz', 'install appkit from CI'."
user-invocable: true
allowed-tools: Read, Edit, Bash, Glob
---

# Install AppKit Tarball

Installs AppKit tgz packages into a project from either the CI prepare-release workflow or a local build.

## Arguments

Parse the user's input to determine mode and options:

- **No args** → CI mode, latest successful prepare-release run, install in CWD
- **GitHub Actions URL** (contains `actions/runs/`) → CI mode, extract run ID from URL
- **Numeric run ID** → CI mode, that specific run
- **`--local <path>`** → Local build mode from the given appkit repo path
- **`--dir <path>`** (combinable with any above) → Override install target directory (default: CWD)

## Workflow

Follow these steps exactly:

### Step 1: Determine target directory

If `--dir` was provided, use that path. Otherwise use the current working directory.
Verify `package.json` exists in the target directory.

### Step 2: Get tgz files

#### Option A: CI mode (default)

**2a. Find the workflow run:**

If no run ID was provided, get the latest successful run:

```bash
gh run list --repo databricks/appkit --workflow prepare-release.yml --status success --limit 1 --json databaseId,number
```

If a GitHub Actions URL was provided, extract the run ID from it (the number after `/runs/`).

**2b. Find the artifact name:**

```bash
gh api "repos/databricks/appkit/actions/runs/{RUN_ID}/artifacts" --jq '.artifacts[] | select(.name | test("^appkit-release-[0-9]")) | .name'
```

**2c. Download the artifact:**

```bash
gh run download {RUN_ID} --repo databricks/appkit --name "{ARTIFACT_NAME}" --dir /tmp/appkit-release-artifacts
```

**2d. Verify checksums:**

```bash
cd /tmp/appkit-release-artifacts && shasum -a 256 -c SHA256SUMS
```

Note: Use `shasum -a 256` (macOS) not `sha256sum` (Linux).

**2e. Print the downloaded version:**

```bash
cat /tmp/appkit-release-artifacts/VERSION
```

The tgz files are now at `/tmp/appkit-release-artifacts/databricks-appkit-*.tgz` and `/tmp/appkit-release-artifacts/databricks-appkit-ui-*.tgz`.

#### Option B: Local build mode

**2a. Build tgz files:**

```bash
cd {LOCAL_APPKIT_PATH} && pnpm pack:sdk
```

**2b. Find the tgz files:**

Glob for `*.tgz` in:
- `{LOCAL_APPKIT_PATH}/packages/appkit/tmp/*.tgz`
- `{LOCAL_APPKIT_PATH}/packages/appkit-ui/tmp/*.tgz`

There should be exactly one tgz in each directory.

### Step 3: Copy tgz files to target directory

Copy both `databricks-appkit-*.tgz` and `databricks-appkit-ui-*.tgz` to the target directory.

### Step 4: Update package.json

Read `package.json` in the target directory. Edit `@databricks/appkit` and `@databricks/appkit-ui` dependency values to use `file:./` prefix pointing to the tgz filenames.

For example, if the tgz file is `databricks-appkit-0.22.0.tgz`:
```json
"@databricks/appkit": "file:./databricks-appkit-0.22.0.tgz"
```

Same pattern for `@databricks/appkit-ui`.

### Step 5: Install dependencies

Run in the target directory:

```bash
npm install --force ./databricks-appkit-{VERSION}.tgz ./databricks-appkit-ui-{VERSION}.tgz
```

### Step 6: Clean up

If CI mode was used, remove the temp directory:

```bash
rm -rf /tmp/appkit-release-artifacts
```

### Step 7: Report

Print a summary:
- Source: CI run #{number} or local build from {path}
- Version installed
- Target directory
- Installed packages
