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

## Step 6: Best-Practices Review

Before evaluating, read the shared review rules in `.claude/references/plugin-review-guidance.md` and apply them throughout this step (deduplication, cache-key tracing).

For each plugin detected in Step 3, review the changed code against the scoped guidelines from Step 5.

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
