# Lakebase "Add Role" — Copy Permissions From

**Date:** 2026-03-12
**Status:** Discussion starter
**Audience:** Lakebase product team
**Tracking:** [LKB-7729](https://databricks.atlassian.net/browse/LKB-7729)

## The problem

The Lakebase UI now supports creating OAuth roles and granting `databricks_superuser` directly — a big improvement over the previous SQL-only workflow. This solves most use cases: developers with `databricks_superuser` get full DML access (SELECT, INSERT, UPDATE, DELETE) to all objects in the database. However, `databricks_superuser` does not grant DDL ownership — a developer still cannot run `CREATE SCHEMA` or `CREATE TABLE` on schemas owned by the Service Principal. 

The current recommended workaround is to deploy the app first so the Service Principal creates all objects, then develop locally for data operations only (see [Database Permissions](https://github.com/databricks/appkit/blob/ecae1a8c157f7f95290dfb4af36976076219bc13/docs/docs/plugins/lakebase.md#database-permissions)).

Beyond the DDL gap, onboarding a new developer to an existing app still requires manually selecting the right system roles and attributes for each new principal. In multi-developer teams this becomes repetitive: every new developer needs the same access profile as an existing principal (typically the project owner or the app's Service Principal). Today there's no way to express "give this person the same permissions as that person" — each role must be configured from scratch.

## Suggestion: add "Copy permissions from" to the Add role UI

Add an optional **"Copy permissions from"** dropdown to the existing "Add role" dialog. When a source principal is selected, the new role inherits the same system roles and attributes.

**Current UI:**

![Current Add role dialog](./original.png)

**Suggested UI (with "Copy permissions from"):**

![Suggested Add role dialog with Copy permissions from](./suggestion.png)

**Why this helps:**

- Covers the most common onboarding case in one step — "same access as the Service Principal" or "same access as the project owner"
- No new concepts - extends the existing Add role flow
- Reduces misconfiguration risk