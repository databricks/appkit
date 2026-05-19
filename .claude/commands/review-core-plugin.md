---
description: Review plugin changes against AppKit best practices (composes with review-pr)
argument-hint: [plugin-name or base-branch]
---

# Review Core Plugin Changes

User input: $ARGUMENTS

## Step 0: Parse Input

Parse `$ARGUMENTS` deterministically:

- If `$ARGUMENTS` is empty:
  - Use no plugin name filter.
  - Use `origin/main` as the base branch.
- Otherwise, check whether either of these paths exists:
  - `packages/appkit/src/plugins/$ARGUMENTS`
  - `packages/appkit/src/connectors/$ARGUMENTS`
- If either path exists:
  - Treat `$ARGUMENTS` as the **plugin name filter**.
  - Use `origin/main` as the base branch.
- Otherwise:
  - Treat `$ARGUMENTS` as the **base branch**.
  - Use no plugin name filter.

Do not use a name-pattern heuristic such as "kebab-case with no slashes" to decide whether `$ARGUMENTS` is a plugin name, because common branch names like `feature-x` and `bugfix-foo` would be ambiguous.

## Step 1: Core Principles Review

First, invoke the `review-pr` skill to run the standard Core Principles review. Pass the base branch as the argument (not the plugin name).

Use the Skill tool:
- skill: `review-pr`
- args: the base branch determined in Step 0 (or empty to use default)

Wait for this review to complete before continuing.

## Step 2: Diff Analysis

Run `git diff <base-branch>...HEAD --name-only` to get all changed files.

Filter the file list to plugin-relevant paths:
- `packages/appkit/src/plugins/**`
- `packages/appkit/src/connectors/**`

If a specific plugin name was provided in Step 0, further filter to only files matching that plugin name in the path.

**If no plugin files are found in the diff**, output:

> No plugin files were changed in this branch. Plugin best-practices review is not applicable. Only the Core Principles review above applies.

Then stop. Do not continue to subsequent steps.

## Step 3: Multi-Plugin Detection

If no specific plugin name was provided, detect all distinct plugins touched in the diff by extracting the plugin directory name from each changed path:
- From `packages/appkit/src/plugins/{name}/...` extract `{name}`
- From `packages/appkit/src/connectors/{name}/...` extract `{name}`

Deduplicate the list. You will run Steps 4-6 for **each** detected plugin.

## Step 4: Category Scoping

For each plugin being reviewed, use the Category Index from `.claude/references/plugin-review-guidance.md` as the canonical list of categories. Map changed files to relevant categories using the "What to check" column as a guide — match file names and code patterns (e.g., `this.route(` → Route Design, `asUser(` → asUser / OBO Patterns). A single file may trigger multiple categories.

Read the actual changed file contents with `git diff <base-branch>...HEAD -- <file>` to determine which patterns are present.

Record which of the 9 categories are **relevant** (at least one changed file maps to them) and which are **skipped** (no changed files map to them).

## Step 5: Load Best Practices Reference

Read the file `.claude/references/plugin-best-practices.md`.

For each **relevant** category identified in Step 4, extract all NEVER, MUST, and SHOULD guidelines from that category section.

## Step 5.5: CLI Cross-Checks (per touched plugin)

For **each** plugin detected in Step 3, run the AppKit CLI checks below before doing the textual review. Treat each non-zero exit or warning as a finding under the indicated category in Step 6.

```bash
# Schema-validate the touched manifest. Failures → Category 1 (Manifest Design), MUST.
npx @databricks/appkit plugin validate packages/appkit/src/plugins/{plugin-name}

# Preview the synced template manifest. Watch for:
#   - The plugin missing from the output when the diff was supposed to add it
#     → Category 0 / Category 1, MUST.
#   - "Plugin '...' was removed. The following resource env vars may be orphaned: ..."
#     when the diff deletes a plugin → flag as a release-note / migration concern.
#   - displayName / package / resource counts that differ from manifest.json
#     → Category 1, SHOULD.
#
# In the monorepo, --plugins-dir points sync at the source manifests (matching
# the sync:template script). Without it, sync scans node_modules/@databricks/
# appkit/dist/plugins/, which may be missing or stale.
npx @databricks/appkit plugin sync --plugins-dir packages/appkit/src/plugins --json
```

Conditional checks (only when the diff matches):

```bash
# Diff changes manifest.json's "stability" field, OR adds/removes the /beta
# import path for this plugin. The dry-run shows exactly which manifest fields
# and which import sites promote would touch — the diff should match. Any
# divergence → Category 0 (Structural Completeness), MUST.
npx @databricks/appkit plugin promote {plugin-name} --to ga --dry-run

# Diff adds entries to manifest.json's resources.required / resources.optional
# arrays. Re-run the canonical scaffolder against an unmodified copy and compare
# — the diff should match what add-resource would have produced (alias,
# resourceKey, permission, fields.env defaults). Hand-rolled entries that drift
# from the defaults → Category 1, SHOULD.
npx @databricks/appkit plugin add-resource \
  --path packages/appkit/src/plugins/{plugin-name} \
  --type {resource-type} \
  --dry-run
```

Capture the relevant output and reference it from the corresponding findings in Step 6.

## Step 5.6: Manifest v2.0 Semantic Checks (per touched plugin)

For each plugin whose `manifest.json` was modified in the diff, apply the v2.0 semantic checks below. Skip this step for plugins whose manifest was not touched. All findings feed Category 1 (Manifest Design) in Step 6.

### 5.6a — Substitutability gate on `scaffolding.rules`

Run these patterns against every entry in `scaffolding.rules.must`, `scaffolding.rules.should`, and `scaffolding.rules.never` of each changed manifest. Severity is **SHOULD** unless noted. Cite `manifest.json` + JSON path (e.g., `scaffolding.rules.must[1]`) for each finding.

1. **Permission duplication.** Rule matches `/permission(?:s)?\s+(?:set\s+(?:as|to)|is|of|=|:)?\s*[A-Z][A-Z_]+/i` AND the named permission value appears in `resources.required[].permission` or `resources.optional[].permission` of the same manifest. **Finding:** duplicates structured `resources.permission` declaration.

2. **Resource-existence tautology.** Rule matches `/Have\s+(?:at\s+least\s+one\s+)?[a-z_-]+\s+resource(?:s)?\s+(?:defined|declared)/i`. **Finding:** trivially satisfied by the manifest declaring the resource.

3. **Inactionable `--set` reference.** Rule contains `--set <token>` where `<token>` does not resolve to a `{plugin-name}.{resourceKey}.{fieldName}` triple present in this manifest's `resources.*[].fields`. **Finding:** refers to a parameter the user cannot supply via `databricks apps init --set`.

4. **Enum-or wording.** Rule matches `/permission\s+(?:set\s+as\s+)?[A-Z_]+\s+or\s+[A-Z_]+/i`. **Finding:** ambiguous; `permission` is a single value.

5. **Length cap.** Schema enforces ≤120 chars per entry. **Severity MUST** if any entry exceeds.

### 5.6b — Discovery descriptor completeness (newly added or modified fields only)

For each `resources.*[].fields.*` entry added or modified in the diff:

1. **Missing discovery on user-supplied field.** Field has `env` set but no `discovery` block → **SHOULD** finding.
2. **Free-form CLI when typed kind exists.** `discovery.type === "cli"` AND the underlying resource appears in `RESOURCE_KIND_COMMANDS` (warehouse, genie_space, postgres_project, postgres_branch, postgres_database, volume) → **SHOULD** finding.
3. **Missing `<PROFILE>` placeholder on `cli` discovery.** Schema catches this, but flag aggressively as **MUST** if it slips through.
4. **Shell metacharacters in `cli` discovery.** Any of `;|&` `` ` `` `$` or newline in `cliCommand`/`shortcut` → **MUST** finding (schema drift).

### 5.6c — `RESOURCE_KIND_COMMANDS.parents` consistency

If a diff adds or modifies a field with `discovery.type === "kind"` AND the kind has `parents` defined in `RESOURCE_KIND_COMMANDS`, verify no contradictory `dependsOn` chain on sibling fields. **Finding (SHOULD):** parents are runtime prompts owned by the kind; combining with `dependsOn` creates ambiguity.

If no manifest files were modified, skip Step 5.6 entirely.

## Step 6: Best-Practices Review

Before evaluating, read the shared review rules in `.claude/references/plugin-review-guidance.md` and apply them throughout this step (deduplication, cache-key tracing).

For each plugin detected in Step 3, review the changed code against the scoped guidelines from Step 5, and **fold in the CLI results from Step 5.5** under the categories noted there.

For each finding:
- Identify the **severity** (NEVER, MUST, or SHOULD)
- Identify the **category** (e.g., "Manifest Design", "Route Design")
- Cite the specific guideline being violated or satisfied
- Reference the exact file and line(s) involved
- Provide a concrete fix if it is a violation

## Step 7: Output

### Format

For each plugin reviewed, output a section with the plugin name as the heading.

Order findings by severity per the Severity Ordering rule in `plugin-review-guidance.md`.

Each finding should follow this format:

```
### [SEVERITY] Category Name: Brief description
- **File:** `path/to/file.ts:L42`
- **Guideline:** <quote the specific guideline>
- **Finding:** <what the code does wrong or right>
- **Fix:** <concrete fix, if a violation>
```

If a plugin has **no findings** (all scoped guidelines are satisfied), state that explicitly.

### Skipped Categories

At the end of the output (after all plugin reviews), list the categories that were **not relevant** to this diff:

```
### Skipped Categories (not relevant to this diff)
- Category N: <Name> — no changed files matched this category
- ...
```

### Summary

End with an overall summary:
- Total findings by severity (e.g., "0 NEVER, 2 MUST, 3 SHOULD")
- Whether the changes are ready to merge from a plugin best-practices perspective
- Any categories that deserve attention even though they were skipped (e.g., "No tests were changed — consider adding tests for the new route")
