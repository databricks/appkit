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
> Available plugins can be listed with: `ls packages/appkit/src/plugins/`

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
