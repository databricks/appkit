---
title: "Lakebase Role & Permission Management — DX Improvements"
type: feat
status: active
date: 2026-03-11
origin: docs/brainstorms/2026-03-11-lakebase-oauth-role-grants-dx-brainstorm.md
---

# Lakebase Role & Permission Management — DX Improvements

## Overview

Developing Databricks Apps with Lakebase requires two PostgreSQL roles: the developer's **OAuth role** (local dev) and the app's **Service Principal role** (deployed). PostgreSQL's ownership model means objects created by one role are inaccessible to the other — producing cryptic "permission denied" errors with no guidance.

Today, the only workaround is a ~10-line SQL script that developers must discover, adapt, and execute manually. This is the single biggest DX friction point in the Lakebase + Apps workflow.

This proposal presents two complementary solutions owned by the **Lakebase platform** — not by application SDKs like AppKit.

## Problem Statement

### Cross-role object access breaks the dev-deploy loop

The core issue is a **permission mismatch between development and deployment roles**.

| Scenario | What happens | Result |
|----------|-------------|--------|
| **Local dev first** | Developer creates tables via ORM migrations (OAuth role) → App deploys (Service Principal) | Service Principal cannot access tables it didn't create |
| **Deployment first** | App creates tables on startup (Service Principal) → Developer connects locally (OAuth role) | Developer cannot read/write tables the app created |

**What the platform does today:** When a Lakebase database is linked to a Databricks App, the platform grants `CONNECT_AND_CREATE` to the Service Principal. However, this does **not** configure `DEFAULT PRIVILEGES` for cross-role access — so each role can only use objects it owns.

### Role management is SQL-only

There is currently **no CLI, API, or UI** for creating OAuth roles, viewing permissions, or managing grants. Developers must:

1. Know to connect via a SQL client
2. Find and adapt a multi-line SQL script ([current docs](https://github.com/databricks/appkit/blob/main/docs/docs/plugins/lakebase.md#local-development))
3. Know the correct subject identifier and schema name
4. Execute without errors

This is a significant barrier — especially for frontend developers or those unfamiliar with PostgreSQL internals.

## Proposed Solutions

### Solution 1: Cross-role DEFAULT PRIVILEGES toggle

**Extend the existing app-database linking flow** with an opt-in toggle (e.g., _"Share object access between app roles"_) that configures `ALTER DEFAULT PRIVILEGES` between the Service Principal and associated OAuth roles.

**What it does:**
- When enabled, objects created by either role are automatically accessible by the other
- Extends the existing `CONNECT_AND_CREATE` mechanism — not a new concept
- Zero ongoing maintenance once enabled

**Why opt-in:**
- Doesn't change behavior for apps that don't need it
- Gives developers explicit control over cross-role access
- No client-side changes needed (no ORM hooks, no `SET ROLE`, no SDK changes)

**Scope:** This covers the most common case (Service Principal + one developer). For multi-developer apps, Solution 2 provides finer-grained control.

### Solution 2: Role management via CLI, API, and UI

Expose role and permission management through **three surfaces**:

**Lakebase API** (foundation):
- `POST /api/2.0/postgres/roles` — Create an OAuth role for a Databricks identity
- `GET /api/2.0/postgres/roles` — List roles and permissions on a database
- `POST /api/2.0/postgres/roles/{role}/grants` — Grant permissions
- `DELETE /api/2.0/postgres/roles/{role}/grants` — Revoke permissions
- Support a `copy_from` parameter during creation to clone permissions from an existing role

**Databricks CLI:**
```
databricks lakebase roles create --identity user@example.com --copy-from <role>
databricks lakebase roles list
databricks lakebase roles grant ...
databricks lakebase roles revoke ...
```

**Lakebase UI:**
- View roles and their permissions on a database
- Create OAuth roles with optional "Copy permissions from" (e.g., copy from Service Principal role)
- Manage grants and DEFAULT PRIVILEGES visually

**Why "Copy from" matters:** PostgreSQL has no native `COPY GRANTS` command. The platform implements this as API-level logic: read grants from source role → replay as GRANT statements for target role. This is the most common use case (new developer needs same access as the app) and eliminates multi-step SQL entirely.

### How the solutions complement each other

| Need | Solution |
|------|----------|
| "Just make it work between my dev role and the app" | Solution 1 (toggle) |
| "Add a new developer to the project" | Solution 2 (CLI/API/UI with copy-from) |
| "Fine-grained permission control" | Solution 2 (grant/revoke) |
| "See what permissions exist" | Solution 2 (list/UI) |

## Approaches Not Recommended

These were considered and rejected (see brainstorm: `docs/brainstorms/2026-03-11-lakebase-oauth-role-grants-dx-brainstorm.md`):

- **Apps UI "Prepare Lakebase" action** — Treats the symptom (missing grants) rather than the cause (no role management tooling). Couples the Apps UI to Lakebase internals.
- **AppKit CLI automation** (`appkit lakebase prepare`) — Papers over a platform gap. Application SDKs should not own database permission logic.

Both push complexity to the wrong layer. Role management belongs in the Lakebase platform.

## Open Discussion Points

1. **Toggle scope:** Should the cross-role DEFAULT PRIVILEGES toggle be per-database, per-app, or per-branch?
2. **Retroactive grants:** When the toggle is enabled, should existing objects also be granted access, or only future ones?
3. **Role discovery:** How does a user find their OAuth role name or the app's Service Principal role? This is currently non-trivial and should be addressed by Solution 2's `list` command.
4. **Multi-user apps:** If multiple developers work on the same app, should all their OAuth roles get cross-grants automatically (via the toggle), or should each be added explicitly (via CLI/API)?
5. **Sequencing:** Is Solution 1 (toggle) feasible near-term as a quick win, while Solution 2 (CLI/API/UI) follows? Or should the API foundation (Solution 2) come first since the toggle could be built on top of it?

## Current State Reference

**What the Lakebase connector does today** (in AppKit / `@databricks/lakebase`):
- `createLakebasePool()` returns a standard `pg.Pool` with automatic OAuth token refresh
- Token lifecycle: 1-hour tokens, 2-minute refresh buffer, concurrent request deduplication
- Credential API: `POST /api/2.0/postgres/credentials`
- No role or grant management — purely connection-level

**What developers must do today** to enable cross-role access:

```sql
CREATE EXTENSION IF NOT EXISTS databricks_auth;

DO $$
DECLARE
  subject TEXT := 'user@example.com';  -- or Service Principal ID
  schema TEXT := 'public';
BEGIN
  PERFORM databricks_create_role(subject, 'USER');
  EXECUTE format('GRANT CONNECT ON DATABASE "databricks_postgres" TO %I', subject);
  EXECUTE format('GRANT ALL ON SCHEMA %s TO %I', schema, subject);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %s TO %I', schema, subject);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %s TO %I', schema, subject);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %s TO %I', schema, subject);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA %s TO %I', schema, subject);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %s GRANT ALL ON TABLES TO %I', schema, subject);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %s GRANT ALL ON SEQUENCES TO %I', schema, subject);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %s GRANT ALL ON FUNCTIONS TO %I', schema, subject);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %s GRANT ALL ON ROUTINES TO %I', schema, subject);
END $$;
```

This is the friction this proposal eliminates.

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-11-lakebase-oauth-role-grants-dx-brainstorm.md](../brainstorms/2026-03-11-lakebase-oauth-role-grants-dx-brainstorm.md) — Key decisions: role management belongs in Lakebase platform (not AppKit), two complementary solutions (toggle + CLI/API/UI), "copy from" as API-level logic
- **Current Lakebase docs:** [docs/docs/plugins/lakebase.md](../docs/plugins/lakebase.md)
- **Lakebase connector source:** `packages/lakebase/src/` (pool.ts, token-refresh.ts, credentials.ts)
