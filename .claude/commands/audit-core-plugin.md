---
description: Full audit of a core plugin against all best-practices categories with scorecard
argument-hint: <plugin-name>
---

# Audit Core Plugin

Perform a full audit of the named plugin against all AppKit plugin best-practices categories and produce a scorecard.

**Plugin name:** $ARGUMENTS

## Step 1: Validate Input

If `$ARGUMENTS` is empty or missing, stop and output:

> Usage: /audit-core-plugin <plugin-name>

Otherwise, set `PLUGIN_NAME` to the value of `$ARGUMENTS` (trimmed, kebab-case).

Check whether the plugin directory exists at either of these paths:

- `packages/appkit/src/plugins/{PLUGIN_NAME}/`
- `packages/appkit/src/connectors/{PLUGIN_NAME}/`

If **neither** path exists, stop and output:

> Error: Plugin "{PLUGIN_NAME}" not found. Checked:
> - `packages/appkit/src/plugins/{PLUGIN_NAME}/`
> - `packages/appkit/src/connectors/{PLUGIN_NAME}/`
>
> Available plugins can be listed with: `npx @databricks/appkit plugin list --dir packages/appkit/src/plugins --json`
> (Falls back to `ls packages/appkit/src/plugins/` if the CLI is unavailable.)

If at least one path exists, proceed.

## Step 2: Load Best Practices Reference

Read the full contents of:

```
.claude/references/plugin-best-practices.md
```

This defines the 9 audit categories and their NEVER/MUST/SHOULD guidelines. You will evaluate the plugin against every guideline in every category.

## Step 3: File Discovery

Read **all** files under:

- `packages/appkit/src/plugins/{PLUGIN_NAME}/` (recursively, including `tests/` subdirectory)
- `packages/appkit/src/connectors/{PLUGIN_NAME}/` (recursively, if this directory exists)

Collect the full contents of every file. You need the complete source to evaluate all 9 categories.

## Step 3.5: CLI Cross-Checks

Before evaluating files by hand, run the AppKit CLI checks below and capture their output. Each result feeds into a specific category in Step 5; treat any non-zero exit as a finding under that category.

```bash
# Schema-validates manifest.json against the plugin-manifest schema.
# Failures → Category 1 (Manifest Design), severity MUST.
npx @databricks/appkit plugin validate packages/appkit/src/plugins/{PLUGIN_NAME}

# Confirms the plugin is discoverable from the synced manifest with the expected
# displayName, package, stability, and resource counts. Mismatches → Category 1
# (Manifest Design) or Category 0 (Structural Completeness).
npx @databricks/appkit plugin list --dir packages/appkit/src/plugins --json \
  | jq '.[] | select(.name == "{PLUGIN_NAME}")'

# Previews the template manifest the loader would emit (no --write).
# Use the output to verify the plugin appears, that resources match manifest.json,
# and that no warnings about orphaned resources / removed plugins are printed.
# Sync-time warnings → Category 1 (Manifest Design), severity SHOULD unless the
# plugin is missing entirely (then MUST).
#
# In the monorepo, --plugins-dir points sync at the source manifests (matching
# the sync:template script). Without it, sync scans node_modules/@databricks/
# appkit/dist/plugins/, which may be missing or stale.
npx @databricks/appkit plugin sync --plugins-dir packages/appkit/src/plugins --json
```

If `plugin validate` exits non-zero, record a MUST finding under Category 1 with the validator's error output as the description, and continue to Step 4 — the rest of the audit still applies.

If `packages/appkit/src/plugins/{PLUGIN_NAME}/` does not exist (connector-only package), skip the three CLI checks and proceed.

## Step 3.6: Manifest v2.0 Semantic Checks

Beyond schema validation, inspect the manifest for v2.0-specific semantic issues that the schema cannot catch. Read `packages/appkit/src/plugins/{PLUGIN_NAME}/manifest.json` and apply each check below. Every match becomes a finding under **Category 1 (Manifest Design)**.

### 3.6a — Substitutability gate on `scaffolding.rules`

For each entry in `scaffolding.rules.must`, `scaffolding.rules.should`, and `scaffolding.rules.never`, test these patterns. Severity is **SHOULD** unless noted.

1. **Permission duplication.** Rule matches `/permission(?:s)?\s+(?:set\s+(?:as|to)|is|of|=|:)?\s*[A-Z][A-Z_]+/i` AND the named permission value appears in any `resources.required[].permission` or `resources.optional[].permission` of the same manifest. Example: rule `"Have permission set as CAN_USE for the defined SQL Warehouse"` when `resources.required[0].permission === "CAN_USE"`. **Finding:** duplicates structured `resources.permission` declaration; the agent already reads the permission from there.

2. **Resource-existence tautology.** Rule matches `/Have\s+(?:at\s+least\s+one\s+)?[a-z_-]+\s+resource(?:s)?\s+(?:defined|declared)/i`. Example: `"Have at least one volume resource defined"`. **Finding:** trivially satisfied by the manifest declaring the resource; carries no agent-actionable signal.

3. **Inactionable `--set` reference.** Rule contains `--set <token>` where `<token>` does not resolve to a `{plugin-name}.{resourceKey}.{fieldName}` triple present in this manifest's `resources.*[].fields`. **Finding:** refers to a parameter the user cannot supply via `databricks apps init --set`.

4. **Enum-or wording.** Rule matches `/permission\s+(?:set\s+as\s+)?[A-Z_]+\s+or\s+[A-Z_]+/i`. Example: `"Have permission set as READ_VOLUME or WRITE_VOLUME"`. **Finding:** ambiguous; the manifest's `permission` field is a single value, not a disjunction. Either drop the rule (gate-violating duplicate) or pin to the specific permission the plugin actually requires.

5. **Length cap.** Schema enforces ≤120 chars per entry; if for any reason a longer rule reached the manifest, flag as **MUST** with the offending entry's length.

For each finding, cite `manifest.json` + the JSON path (e.g., `scaffolding.rules.must[1]`).

### 3.6b — Discovery descriptor completeness

For each resource field declared in `resources.required[].fields` or `resources.optional[].fields`:

1. **Missing discovery on user-supplied field.** Field has `env` set (signalling user-supplied at scaffold time) but no `discovery` block. **Finding (SHOULD):** field is user-supplied but lacks a discovery descriptor; agents fall back to free-text prompting.

2. **Free-form CLI when typed kind exists.** Field uses `discovery.type === "cli"` AND the underlying resource kind appears in `RESOURCE_KIND_COMMANDS` (warehouse, genie_space, postgres_project, postgres_branch, postgres_database, volume). **Finding (SHOULD):** typed `kind` variant is preferred — AppKit owns the command map and response unwrapping; free-form `cli` is an escape hatch for resources without a typed kind.

3. **Missing `<PROFILE>` placeholder on `cli` discovery.** Field uses `discovery.type === "cli"` AND `discovery.cliCommand` does NOT contain the literal substring `<PROFILE>`. **Finding (MUST):** the schema enforces this, so a hit here would indicate schema drift or a freshly added entry — flag aggressively.

4. **Shell metacharacters in `cli` discovery.** `discovery.cliCommand` or `discovery.shortcut` contains any of `;|&` `` ` `` `$` or newline. **Finding (MUST):** the schema rejects these; same drift signal as above.

### 3.6c — `RESOURCE_KIND_COMMANDS.parents` consistency

If the manifest declares a field with `discovery.type === "kind"` AND that kind has `parents` in `RESOURCE_KIND_COMMANDS` (e.g., `volume.parents === ["catalog", "schema"]`), verify no contradictory `dependsOn` chain is also declared on sibling fields. **Finding (SHOULD):** parents are runtime prompts owned by the kind, not sibling fields — using both creates ambiguity for the agent.

If `packages/appkit/src/plugins/{PLUGIN_NAME}/manifest.json` does not exist (connector-only package), skip Step 3.6 entirely.

## Step 4: Structural Completeness Check

If `packages/appkit/src/plugins/{PLUGIN_NAME}/` does not exist (connector-only package), mark Structural Completeness as **N/A** in the scorecard and proceed to Step 5.

Otherwise, verify the following expected files exist inside `packages/appkit/src/plugins/{PLUGIN_NAME}/`:

| Expected file | Required? |
|---|---|
| `manifest.json` | MUST |
| Main plugin class file (any `.ts` file containing a class extending `Plugin`) | MUST |
| `types.ts` | MUST |
| `defaults.ts` | SHOULD |
| `index.ts` | MUST |
| `tests/` directory with at least one `.test.ts` file | MUST |

Treat each missing `MUST` file as a **MUST**-severity finding under the "Structural Completeness" category. Treat a missing `SHOULD` file as a **SHOULD**-severity finding.

`defaults.ts` is not universally required for every plugin. It should be present when the plugin exposes execution settings or defines behavior that depends on `execute()` / `executeStream()` defaults, but its absence alone should not be reported as a MUST failure for plugins that do not use those defaults.

> **Note:** The structural completeness check applies only to the `plugins/{PLUGIN_NAME}/` directory. Connector directories (`connectors/{PLUGIN_NAME}/`) serve a different architectural role and are read as supporting context for the best-practices review, not audited for structural completeness.

## Step 5: Full Best-Practices Review

Before evaluating, read the shared review rules in `.claude/references/plugin-review-guidance.md` and apply them throughout this step (deduplication, cache-key tracing).

Fold the Step 3.5 CLI results into the matching categories:
- `plugin validate` failures → Category 1 (Manifest Design), MUST.
- `plugin list --json` mismatches between manifest fields and synced output → Category 1 (Manifest Design), SHOULD unless the plugin is absent (MUST).
- `plugin sync --json` warnings about orphaned resources / removed plugins → Category 0 (Structural Completeness) or Category 1, severity per the warning text.
- If the manifest declares `"stability": "beta"`, also run `npx @databricks/appkit plugin promote {PLUGIN_NAME} --to ga --dry-run`. Any rewrites it would perform that conflict with the current `/beta` re-export wiring → Category 0 (Structural Completeness), SHOULD.

Fold the Step 3.6 v2.0 semantic-check results into Category 1 (Manifest Design) at the severity recorded by each sub-check (3.6a, 3.6b, 3.6c).

Evaluate the plugin code against **all 9 categories** from the Category Index in `plugin-review-guidance.md`. Check each category's NEVER/MUST/SHOULD rules from the best-practices reference.

For each guideline in each category, determine whether the plugin **passes**, **violates**, or is **not applicable** (e.g., SSE rules for a non-streaming plugin). Record findings with:

- **Severity**: NEVER, MUST, or SHOULD (from the guideline prefix)
- **Category**: Which of the 9 categories
- **Description**: What the guideline requires and how the plugin violates it
- **Location**: Specific `file:line` reference(s)

A category with no findings is a pass. A category with only SHOULD findings is a warn. A category with any MUST or NEVER finding is a fail.

## Step 6: Produce Output

### Scorecard Table (output first)

```
## Scorecard

| # | Category | Status | Findings |
|---|----------|--------|----------|
| 0 | Structural Completeness | {status} | {count} |
| 1 | Manifest Design | {status} | {count} |
| 2 | Plugin Class Structure | {status} | {count} |
| 3 | Route Design | {status} | {count} |
| 4 | Interceptor Usage | {status} | {count} |
| 5 | asUser / OBO Patterns | {status} | {count} |
| 6 | Client Config | {status} | {count} |
| 7 | SSE Streaming | {status} | {count} |
| 8 | Testing Expectations | {status} | {count} |
| 9 | Type Safety | {status} | {count} |
```

> Category 0 (Structural Completeness) is a file-layout pre-check from Step 4 and has no corresponding section in `plugin-best-practices.md`. Categories 1–9 mirror sections 1–9 of the best-practices reference.

Where `{status}` is one of:
- Pass — no findings
- Warn — SHOULD-only findings
- Fail — any NEVER or MUST findings
- N/A — category does not apply to this plugin (e.g., SSE Streaming for a non-streaming plugin)

And `{count}` is the number of findings (0 if pass).

### Detailed Findings (output second, severity-first)

Group all findings across all categories and sort by severity per the Severity Ordering rule in `plugin-review-guidance.md`.

For each finding, output:

```
### [{severity}] {category}: {short description}

**File:** `{file_path}:{line_number}`

{Explanation of what the guideline requires, what the code does wrong, and how to fix it.}
```

If there are zero findings across all categories, output:

> All checks passed. No findings.

### Summary (output last)

End with a one-line summary:

> **Audit result: {total_findings} findings ({never_count} NEVER, {must_count} MUST, {should_count} SHOULD) across {failing_categories} failing and {warning_categories} warning categories.**
