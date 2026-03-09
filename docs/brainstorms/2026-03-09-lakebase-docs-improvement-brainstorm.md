# Brainstorm: Lakebase Plugin Setup Docs Improvement

**Date:** 2026-03-09
**Status:** Ready for planning

## What We're Building

A rewrite of the Lakebase plugin setup documentation (`docs/docs/plugins/lakebase.md`) to transform the current 6-step mixed UI/CLI walkthrough into a single, annotated CLI command sequence. The goal is to make the instructions equally effective for humans reading the docs and AI/CI agents executing the setup programmatically.

## Why This Approach

The current docs suffer from four compounding problems:
1. **Steps are hard to follow** — the flow between UI, CLI, and SQL editor is disorienting
2. **Too much context-switching** — users bounce between Databricks UI, terminal, SQL editor, and config files
3. **Variable tracking is error-prone** — values like `DATABRICKS_CLIENT_ID`, project ID, and branch ID must be manually noted and carried across 6 steps
4. **Not copy-paste friendly** — placeholders like `{project-id}` are hard for both humans and agents to fill correctly

The fix: a single shell script block with inline comments, using shell variables to thread values through the entire flow. No screenshots. Full CLI path using `databricks` CLI, `jq`, and `psql`.

## Key Decisions

1. **Single annotated script block** — The entire setup is one continuous `sh` fenced code block with `#` comments explaining each step. No numbered prose sections, no screenshots. This is the most agent-friendly format and avoids duplication.

2. **Full CLI, no UI steps** — Every step uses CLI commands:
   - `databricks apps get` to find the service principal (instead of navigating Environment tab)
   - `databricks postgres list-endpoints` + `jq` for endpoint discovery
   - `databricks postgres generate-database-credential` for OAuth token
   - `psql` with heredoc for executing the grant SQL
   - `psql` query to verify the role was created

3. **Shell variables as the threading mechanism** — Users set variables (`PROJECT_ID`, `BRANCH_ID`, `APP_NAME`) once at the top and all subsequent commands reference them. This eliminates manual value tracking.

4. **Remove all screenshots** — The CLI-first approach makes screenshots unnecessary. Cleaner doc, easier to maintain, better for agents.

5. **Reorder steps** — Lakebase project creation comes first (yields `PROJECT_ID`, `BRANCH_ID`, `PGHOST`, `PGDATABASE`), then app service principal lookup, then endpoint discovery, then grant SQL. This follows the natural dependency order.

6. **psql for SQL execution** — The grant SQL runs via `psql` with a heredoc, authenticated using `databricks postgres generate-database-credential`. Fully scriptable, no SQL Editor UI needed.

7. **psql query for verification** — Instead of "check the Roles & Databases tab," run a `SELECT rolname FROM pg_roles` query to confirm the role exists.

## Proposed Command Sequence Structure

```
# 1. Set your Lakebase project details (from the URL in the Compute tab)
PROJECT_ID=...
BRANCH_ID=...

# 2. Get connection parameters (from the Connect dialog)
PGHOST=...
PGDATABASE=databricks_postgres

# 3. Find the endpoint
LAKEBASE_ENDPOINT=$(databricks postgres list-endpoints ... | jq ...)

# 4. Get the app's service principal
APP_NAME=...
SP_CLIENT_ID=$(databricks apps get ... | jq ...)

# 5. Generate OAuth token and grant access via psql
PGPASSWORD=$(databricks postgres generate-database-credential ...)
psql ... <<'SQL'
  CREATE EXTENSION IF NOT EXISTS databricks_auth;
  DO $$ ... $$;
SQL

# 6. Verify the role
psql ... -c "SELECT rolname FROM pg_roles WHERE rolname = '...'"
```

## Open Questions

_None — all questions resolved during brainstorming._

## Resolved Questions

- **Agent type**: Both AI coding agents and CI/CD automation (docs should work for both)
- **CLI vs UI balance**: Full CLI where possible — no UI steps remain
- **Screenshots**: Remove all 5 screenshots
- **Quick ref vs detailed walkthrough**: Single command sequence with comments (no duplication)
- **SQL execution method**: psql with heredoc, authenticated via `databricks postgres generate-database-credential`
- **Verification**: psql query (`SELECT rolname FROM pg_roles`) instead of UI tab check
- **Doc structure**: Approach A — single annotated script block (most concise, most agent-friendly)
