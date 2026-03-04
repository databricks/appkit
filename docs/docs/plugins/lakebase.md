---
sidebar_position: 4
---

# Lakebase plugin

Provides a PostgreSQL connection pool for Databricks Lakebase Autoscaling with automatic OAuth token refresh.

**Key features:**
- Standard `pg.Pool` compatible with any PostgreSQL library or ORM
- Automatic OAuth token refresh (1-hour tokens, 2-minute refresh buffer)
- Token caching to minimize API calls
- Built-in OpenTelemetry instrumentation (query duration, pool connections, token refresh)
- AppKit logger configured by default for query and connection events

## Getting started with the Lakebase

The easiest way to get started with the Lakebase plugin is to use the Databricks CLI to create a new Databricks app with AppKit installed and the Lakebase plugin.

### Prerequisites

- [Node.js](https://nodejs.org) v22+ environment with `npm`
- Databricks CLI (v0.287.0 or higher): install and configure it according to the [official tutorial](https://docs.databricks.com/aws/en/dev-tools/cli/tutorial).
- A new Databricks app with AppKit installed. See [Bootstrap a new Databricks app](../index.md#quick-start-options) for more details.

### Steps

1. Firstly, create a new Lakebase Postgres Autoscaling project according to the [Get started documentation](https://docs.databricks.com/aws/en/oltp/projects/get-started).
1. To add the Lakebase plugin to your project, run the `databricks apps init` command and interactively select the **Lakebase** plugin. The CLI will guide you through picking a Lakebase project, branch, and database.
    - When asked, select **Yes** to deploy the app to Databricks Apps right after its creation.

## Basic usage

```ts
import { createApp, lakebase, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), lakebase()],
});
```

## Accessing the pool

After initialization, access Lakebase through the `AppKit.lakebase` object:

```ts
const AppKit = await createApp({
  plugins: [server(), lakebase()],
});

// Direct query (parameterized)
const result = await AppKit.lakebase.query(
  "SELECT * FROM orders WHERE user_id = $1",
  [userId],
);

// Raw pg.Pool (for ORMs or advanced usage)
const pool = AppKit.lakebase.pool;

// ORM-ready config objects
const ormConfig = AppKit.lakebase.getOrmConfig();  // { host, port, database, ... }
const pgConfig = AppKit.lakebase.getPgConfig();    // pg.PoolConfig
```

## Configuration

### Environment variables

The required environment variables are:

| Variable | Description |
|---|---|
| `LAKEBASE_ENDPOINT` | Endpoint resource path (e.g. `projects/.../branches/.../endpoints/...`) |
| `PGHOST` | Lakebase host (auto-injected in production by the `postgres` Databricks Apps resource) |
| `PGDATABASE` | Database name (auto-injected in production by the `postgres` Databricks Apps resource) |
| `PGSSLMODE` | TLS mode — set to `require` (auto-injected in production by the `postgres` Databricks Apps resource) |

When deployed to Databricks Apps with a `postgres` database resource configured, `PGHOST`, `PGDATABASE`, `PGSSLMODE`, `PGUSER`, `PGPORT`, and `PGAPPNAME` are automatically injected by the platform. Only `LAKEBASE_ENDPOINT` must be set explicitly:

```yaml
env:
  - name: LAKEBASE_ENDPOINT
    valueFrom: postgres
```

For local development, set all variables in your `.env` file:

```env
PGHOST=your-lakebase-host.databricks.com
PGDATABASE=databricks_postgres
LAKEBASE_ENDPOINT=projects/<project-id>/branches/<branch-id>/endpoints/<endpoint-id>
PGSSLMODE=require
```

You can copy them from already deployed app in the UI (**Compute > Apps > \{app-name\} > Environment** tab).

For the full configuration reference (SSL, pool size, timeouts, logging, ORM examples), see the [`@databricks/lakebase` README](https://github.com/databricks/appkit/blob/main/packages/lakebase/README.md).

### Pool configuration

Pass a `pool` object to override any defaults:

```ts
await createApp({
  plugins: [
    lakebase({
      pool: {
        max: 10,                      // Max pool connections (default: 10)
        connectionTimeoutMillis: 5000, // Connection timeout ms (default: 10000)
        idleTimeoutMillis: 30000,      // Idle connection timeout ms (default: 30000)
      },
    }),
  ],
});
```

## Database Permissions

When you create the app with the Lakebase resource using the [Getting started](#getting-started-with-the-lakebase) guide, the Service Principal is automatically granted `CONNECT_AND_CREATE` permission on the `postgres` resource.

### Local development

Your Databricks user identity (email) is used for OAuth authentication. No additional permissions are required if you are the project owner.

:::tip
[Postgres password authentication](https://docs.databricks.com/aws/en/oltp/projects/authentication#overview) is a simpler alternative that avoids OAuth role permission complexity.
:::

If you are not the project owner, [create an OAuth role](https://docs.databricks.com/aws/en/oltp/projects/postgres-roles) and grant permissions using the SQL below.

:::note
Deploy and run the app at least once before executing these grants so the Service Principal initializes the database schema first.
:::

Replace `subject` with your user email.

```sql
CREATE EXTENSION IF NOT EXISTS databricks_auth;

DO $$
DECLARE
  subject TEXT := 'your-subject';  -- User email like name@databricks.com
BEGIN
  -- Create OAuth role for the Databricks identity
  PERFORM databricks_create_role(subject, 'USER');

  -- Connection and schema access
  EXECUTE format('GRANT CONNECT ON DATABASE "databricks_postgres" TO %I', subject);
  EXECUTE format('GRANT ALL ON SCHEMA public TO %I', subject);

  -- Privileges on existing objects
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', subject);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO %I', subject);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO %I', subject);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA public TO %I', subject);

  -- Default privileges on future objects
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', subject);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', subject);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO %I', subject);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO %I', subject);
END $$;
```

For more details, see [Manage database permissions](https://docs.databricks.com/aws/en/oltp/projects/manage-roles-permissions).