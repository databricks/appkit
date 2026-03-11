# Lakebase Role & Permission Management — DX Improvements

**Date:** 2026-03-11
**Status:** Discussion starter
**Audience:** Lakebase product team, Apps team

## The Problem

Developing Databricks Apps with Lakebase involves two significant DX pain points around database roles and permissions.

### Problem 1: Cross-role object access

When developing Apps with Lakebase, developers face a **permission mismatch between their OAuth role and the app's Service Principal role**. PostgreSQL's ownership model means only the role that creates an object has access to it — the other role is locked out.

**Scenario A — "Local dev first":**

1. Developer creates tables locally using their **OAuth role** (e.g., via ORM migrations)
2. App is deployed — the **Service Principal** tries to access those tables
3. **Failure** — Service Principal has no grants on objects owned by the OAuth role

**Scenario B — "Deployment first":**

1. App is deployed — the **Service Principal** creates tables (e.g., via ORM migrations on startup)
2. Developer connects locally with their **OAuth role** to inspect or iterate on the data
3. **Failure** — OAuth role has no grants on objects owned by the Service Principal

Both scenarios require manually running ~10 lines of SQL GRANTs and ALTER DEFAULT PRIVILEGES for each role pair (see appendix). This is error-prone, undiscoverable, and produces cryptic "permission denied" errors with no guidance.

**What already exists:** When a Lakebase database is associated with a Databricks App, the platform automatically grants `CONNECT_AND_CREATE` to the app's Service Principal. However, this does **not** set up `DEFAULT PRIVILEGES` for cross-role object access.

### Problem 2: Role management is SQL-only

Creating OAuth roles and managing their permissions requires connecting directly to the Postgres database and executing SQL — including calling the `databricks_create_role` extension function and running multiple GRANT statements.

There is currently **no CLI command, API endpoint, or UI** for:

- Creating an OAuth role for a Databricks identity
- Viewing which roles exist and what permissions they have
- Granting/revoking permissions between roles
- Setting up DEFAULT PRIVILEGES

This means every developer who needs local access to a deployed app's database must:

1. Know to connect to the database via a SQL client
2. Find and adapt a multi-line SQL script (see [AppKit Lakebase docs](https://github.com/databricks/appkit/blob/main/docs/docs/plugins/lakebase.md#local-development))
3. Know the correct subject identifier and schema name
4. Execute the script without errors

This is a significant barrier, especially for frontend developers or those unfamiliar with PostgreSQL role management.

## Proposed Solutions

### 1. Extend automatic grants with cross-role DEFAULT PRIVILEGES (opt-in toggle)

When a Lakebase database is linked to a Databricks App, offer a **toggle** (e.g., "Share object access between app roles") that sets up `ALTER DEFAULT PRIVILEGES` between the app's Service Principal role and associated OAuth roles. Objects created by either role would automatically be accessible by the other.

**Why this works:**

- Extends the existing `CONNECT_AND_CREATE` grant mechanism — not a new concept
- Opt-in gives developers control; doesn't change behavior for those who don't need it
- Zero ongoing maintenance once enabled — DEFAULT PRIVILEGES apply to all future objects
- No client-side changes needed (no ORM hooks, no SET ROLE, no SDK changes)

### 2. Role management via CLI, API, and UI

Expose role and permission management through **three surfaces** — not just raw SQL:

**Databricks CLI:**
- `databricks lakebase roles create --identity user@example.com --copy-from <role>` — create an OAuth role, optionally copying permissions from an existing role
- `databricks lakebase roles list` — view roles and their permissions on a database
- `databricks lakebase roles grant` / `revoke` — manage permissions between roles

**Lakebase API:**
- REST endpoints for role CRUD and permission management (e.g., `POST /api/2.0/postgres/roles`)
- Foundation that powers both the CLI and UI

**Lakebase UI:**
- View which roles exist on a database and their permissions
- Create OAuth roles for Databricks identities, with an option to **copy permissions from an existing role** (e.g., "Copy from: Service Principal role") — so the new role is immediately usable without manual GRANTs
- Grant/revoke permissions between roles visually
- Set up DEFAULT PRIVILEGES without writing SQL

**Why this works:**

- Gives visibility into the permission model (currently completely opaque without a SQL client)
- Eliminates the need for developers to know PostgreSQL role management SQL
- "Copy from existing role" during creation covers the most common use case in one step
- Useful beyond the Apps use case — any multi-role Lakebase setup benefits
- Complements the toggle in Solution 1 for users who need finer-grained control

## Not Recommended (Workarounds)

The following approaches address symptoms but push complexity to the wrong layer.

**Apps UI — "Prepare Lakebase" action** — A one-click action in the Apps UI that configures grants between the Service Principal and the current user's OAuth role. While discoverable, it treats the symptom (missing grants) rather than the cause (no proper role management tooling). It also couples the Apps UI to Lakebase internals.

**CLI/SDK automation (AppKit-side)** — An AppKit command like `appkit lakebase prepare` that runs the GRANT statements via SQL. This is the quickest to ship but papers over a platform gap. Application SDKs should not own database permission logic — that belongs in the Lakebase platform (Solution 2).

## Discussion Points

1. **Toggle scope:** Should the cross-role DEFAULT PRIVILEGES toggle be per-database, per-app, or per-branch?
2. **Retroactive grants:** When enabled, should existing objects also be granted, or only future ones?
3. **Role discovery:** How does a user find the role ID of their OAuth role or the app's Service Principal? This is currently non-trivial.
4. **Multi-user apps:** If multiple developers work on the same app, should all their OAuth roles get cross-grants?
5. **Timeline:** Is Solution 1 (toggle) feasible near-term, or should Solution 2 (CLI/API/UI) be prioritized first?

## Appendix: Current SQL Workaround

This is what developers must run today to grant cross-role access (from [AppKit Lakebase docs](https://github.com/databricks/appkit/blob/main/docs/docs/plugins/lakebase.md#local-development)):

```sql
CREATE EXTENSION IF NOT EXISTS databricks_auth;

DO $$
DECLARE
  subject TEXT := 'your-subject';  -- User email or Service Principal ID
  schema TEXT := 'your_schema';
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

## Appendix: How "Copy Permissions From" Would Work

PostgreSQL has no native `COPY GRANTS FROM role_a TO role_b` command. The Lakebase platform would implement this as API-level logic:

1. **Read existing grants** from the source role:
   ```sql
   -- Table, view, and column grants
   SELECT * FROM information_schema.role_table_grants WHERE grantee = 'source_role';
   -- Sequence, domain, and other usage grants
   SELECT * FROM information_schema.role_usage_grants WHERE grantee = 'source_role';
   ```

2. **Read DEFAULT PRIVILEGES** from the source role:
   ```sql
   SELECT defaclnamespace::regnamespace, defaclobjtype, defaclacl
   FROM pg_default_acl
   WHERE defaclrole = 'source_role'::regrole;
   ```

3. **Replay as GRANT/ALTER DEFAULT PRIVILEGES** statements for the target role.

This is straightforward for the platform to implement and reinforces why "copy from" belongs in the Lakebase API layer rather than as raw SQL that developers write.
