# Lakebase Role & Permission Management — Resolution via `databricks_superuser`

**Date:** 2026-03-11
**Status:** Follow-up to [original brainstorm](./2026-03-11-lakebase-oauth-role-grants-dx-brainstorm.md)
**Audience:** Lakebase product team, Apps team

## Summary

The original brainstorm identified two DX pain points: cross-role object access and SQL-only role management. Since then, the Lakebase UI has shipped **"Add role"** and **"Edit role"** dialogs that allow granting the `databricks_superuser` system role directly from the UI. This largely resolves both problems for the common Databricks Apps workflow.

## What changed

The Lakebase Autoscaling UI (Branch Overview page) now supports:

- **Add role** — create a new OAuth or Password role for any Databricks identity (user, group, or service principal), with the option to assign `databricks_superuser` and system attributes (CREATEDB, CREATEROLE, BYPASSRLS).
- **Edit role** — grant `databricks_superuser` and system attributes to an existing role (e.g., a Service Principal role that was auto-created when linking a database to an app).

The `databricks_superuser` role gives **read and write access to all data** in the database.

## What this resolves

### Problem 1: Cross-role object access — mostly resolved

With `databricks_superuser`, a developer's OAuth role gets full **DML access** (SELECT, INSERT, UPDATE, DELETE) to all objects in the database, regardless of which role owns them. The ~10-line SQL GRANT script is no longer necessary for data access.

### Problem 2: Role management is SQL-only — resolved for the common case

Creating an OAuth role and granting `databricks_superuser` can now be done entirely through the Lakebase UI. No SQL client needed, no `databricks_create_role` calls, no GRANT statements.

## What this does NOT resolve

### DDL ownership remains role-scoped

`databricks_superuser` grants DML access but **does not transfer object ownership**. A user with `databricks_superuser` cannot run DDL (CREATE SCHEMA, CREATE TABLE, ALTER TABLE) on schemas owned by the Service Principal.

This means the following workflow still fails:

1. App deploys — Service Principal creates `app` schema and tables (becomes owner)
2. Developer runs locally with `databricks_superuser` — tries `CREATE TABLE IF NOT EXISTS` on the `app` schema
3. **Failure** — developer is not the schema owner, DDL is rejected

### The "deploy first" convention handles this

Apps generated from `databricks apps init` already implement a pattern that avoids DDL conflicts: they check whether schemas and tables exist before attempting to create them, and skip creation if they do. This means:

- **Deploy the app first** — the Service Principal creates the schema and tables
- **Then develop locally** — the developer uses `databricks_superuser` for DML only; the app skips DDL since the schema already exists

This convention is sufficient as long as app templates consistently implement it.

## Recommended workflow

For the common Databricks Apps + Lakebase development flow:

1. Create and deploy the app (Service Principal creates database schema)
2. In the Lakebase UI (Branch Overview), add an OAuth role for each developer with `databricks_superuser`
3. Developers run locally — full data access, no SQL GRANTs needed

The SQL GRANT script remains a fallback for teams that need fine-grained permissions instead of `databricks_superuser`.

## Discussion points

1. **Should `databricks_superuser` be the default for app-linked databases?** When a Lakebase database is associated with a Databricks App, the platform already auto-grants `CONNECT_AND_CREATE` to the Service Principal. Should it also auto-assign `databricks_superuser` to the project owner's OAuth role?

2. **Is the "deploy first" convention enough?** The DDL ownership limitation is handled by app template conventions, not platform enforcement. Should we add tooling or documentation to make this workflow more explicit (e.g., a startup check that warns if running locally without a deployed schema)?

3. **CLI and API for role management:** The UI resolves the immediate DX pain, but CLI (`databricks lakebase roles create`) and API endpoints would still benefit automation and CI/CD workflows. Is this still a priority, or is the UI sufficient for now?

4. **Multi-developer teams:** For teams with multiple developers, each developer needs `databricks_superuser` granted individually via the UI. Should there be a bulk grant mechanism or a project-level default?

5. **What about the original proposals?** The original brainstorm proposed a cross-role DEFAULT PRIVILEGES toggle and CLI/API/UI for role management. With `databricks_superuser` available via the UI, are these still needed? The toggle would solve DDL ownership too (via DEFAULT PRIVILEGES), but may be unnecessary if the "deploy first" convention holds.
