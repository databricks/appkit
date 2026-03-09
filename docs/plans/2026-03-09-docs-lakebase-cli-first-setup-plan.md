---
title: "docs: Rewrite Lakebase setup as CLI-first annotated script"
type: docs
status: active
date: 2026-03-09
origin: docs/brainstorms/2026-03-09-lakebase-docs-improvement-brainstorm.md
---

# docs: Rewrite Lakebase setup as CLI-first annotated script

## Overview

Rewrite the "Setting up Lakebase" section of `docs/docs/plugins/lakebase.md` from a 6-step mixed UI/CLI/SQL Editor walkthrough into a single annotated shell script block. The goal is to make setup equally effective for humans reading docs and AI/CI agents executing programmatically. (see brainstorm: `docs/brainstorms/2026-03-09-lakebase-docs-improvement-brainstorm.md`)

## Proposed Solution

Replace the current 6 numbered H3 sections + 5 screenshots with:

1. A **prerequisites** note listing required tools
2. A **single `sh` code block** with inline `#` comments, using shell variables to thread values through the entire flow
3. Keep all non-setup sections unchanged (Basic usage, Environment variables, Accessing the pool, Configuration options)

### The script flow

```
# Prerequisites note above the block

# --- Variables from Lakebase UI ---
PROJECT_ID=...          # From URL: /projects/{id}/branches/...
BRANCH_ID=...           # From URL: .../branches/{id}
PGHOST=...              # From Connect dialog
PGDATABASE=databricks_postgres

# --- Variables from CLI ---
LAKEBASE_ENDPOINT=$(databricks postgres list-endpoints "projects/${PROJECT_ID}/branches/${BRANCH_ID}" | jq -r '.[0].name')

APP_NAME=...            # Your Databricks App name
SP_CLIENT_ID=$(databricks apps get "${APP_NAME}" | jq -r '.service_principal_client_id')

# --- Grant access via psql ---
export PGSSLMODE=require
export PGPASSWORD=$(databricks postgres generate-database-credential "${LAKEBASE_ENDPOINT}" | jq -r '.token')

psql -h "${PGHOST}" -d "${PGDATABASE}" -U "$(databricks auth me | jq -r '.user_name')" <<'SQL'
CREATE EXTENSION IF NOT EXISTS databricks_auth;
DO $$
DECLARE
  sp TEXT := current_setting('appkit.sp_client_id');  -- or use shell variable substitution
BEGIN
  PERFORM databricks_create_role(sp, 'SERVICE_PRINCIPAL');
  EXECUTE format('GRANT CONNECT ON DATABASE "databricks_postgres" TO %I', sp);
  -- ... remaining grants
END $$;
SQL

# --- Verify ---
psql ... -c "SELECT rolname FROM pg_roles WHERE rolname = '${SP_CLIENT_ID}'"
```

> **Note:** The exact psql user and variable passing mechanism needs validation against a real workspace. See "Questions to resolve" below.

### What changes in the file

| Section | Action |
|---|---|
| `:::info` admonition (line 8) | Rewrite: mention CLI tools required, some values still come from UI |
| `### 1.` through `### 6.` (lines 19-98) | **Replace entirely** with prerequisites + single script block |
| `## Basic usage` onward (lines 100+) | No changes |
| Screenshot images | Delete `docs/docs/plugins/assets/lakebase-setup/step-{1,2,4,5,6}.png` |

## Acceptance Criteria

- [x] Single `sh` fenced code block replaces all 6 setup steps
- [x] Shell variables thread all values (`PROJECT_ID`, `BRANCH_ID`, `PGHOST`, `PGDATABASE`, `LAKEBASE_ENDPOINT`, `APP_NAME`, `SP_CLIENT_ID`, `PGPASSWORD`, `PGSSLMODE`)
- [x] Inline `#` comments explain what each section does
- [x] Prerequisites listed before the script (Databricks CLI, `jq`, `psql`)
- [x] All 5 screenshots removed (files deleted)
- [x] `:::info` admonition updated
- [x] Non-setup sections (Basic usage, Env vars, Pool access, Config) unchanged
- [x] Brief text before script explains where UI values come from (project URL pattern, Connect dialog)
- [x] Verification step uses `psql` query instead of UI tab check
- [x] `PGSSLMODE=require` included in the script
- [x] Doc stays `.md` (no MDX imports needed)

## Questions to Resolve Before/During Implementation

These came from SpecFlow analysis and need validation against a real Databricks workspace:

### Critical

1. **`databricks apps get` JSON path for service principal** — Is it `.service_principal_client_id` at the top level? Run `databricks apps get <name> | jq '.'` to confirm.

2. **psql user identity** — When authenticating with `generate-database-credential` token, what `PGUSER` does psql need? Options: (a) the caller's Databricks email, (b) a fixed string, (c) the token implicitly identifies the user. Run `databricks auth me | jq '.user_name'` to find the value.

3. **Passing SP_CLIENT_ID into the SQL heredoc** — A `<<'SQL'` heredoc does NOT expand shell variables. Either use `<<"SQL"` (unquoted, allows expansion) or use `psql -v sp_client_id="${SP_CLIENT_ID}"` and `:sp_client_id` in SQL. Need to pick the approach.

### Important

4. **Is `databricks_create_role` idempotent?** — If the role already exists, does it error or no-op? Determines whether re-running the script is safe without guards.

5. **Multiple endpoints on a branch** — `.[0].name` silently picks the first. Add a comment: `# Uses the first endpoint; branches typically have one`.

6. **Can PGHOST be derived from CLI?** — Check if `databricks postgres get-branch` or `databricks postgres get-endpoint` returns host info. If yes, we can make the script even more CLI-complete.

## Implementation Notes

- The `perms-wip` git stash (`stash@{0}`) has a partial draft of this rewrite — apply it as a starting point
- The grant SQL block itself is correct and tested (from current doc lines 66-89) — only the delivery mechanism changes (psql heredoc vs SQL Editor)
- `generate-database-credential` CLI confirmed: takes `ENDPOINT` positional arg, returns `{ token, expire_time }` JSON
- `list-endpoints` CLI confirmed: takes `PARENT` positional arg (format: `projects/{id}/branches/{id}`), returns JSON array

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-09-lakebase-docs-improvement-brainstorm.md](../brainstorms/2026-03-09-lakebase-docs-improvement-brainstorm.md) — Key decisions: single script block, full CLI, no screenshots, shell variable threading, psql for SQL execution
- Current doc: `docs/docs/plugins/lakebase.md`
- CLI help: `databricks postgres --help`, `databricks postgres generate-database-credential --help`
- Credential API: `packages/lakebase/src/credentials.ts` — `POST /api/2.0/postgres/credentials`
- Stash with draft: `git stash show -p stash@{0}` (perms-wip)
