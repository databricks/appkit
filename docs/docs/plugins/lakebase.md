---
sidebar_position: 4
---

# Lakebase plugin

:::info
This setup requires a one-time manual process to connect your Databricks App's service principal to your Lakebase database. You'll need the [Databricks CLI](https://docs.databricks.com/dev-tools/cli/install.html), [`jq`](https://jqlang.github.io/jq/), and [`psql`](https://www.postgresql.org/download/) installed locally.
:::

Provides a PostgreSQL connection pool for Databricks Lakebase Autoscaling with automatic OAuth token refresh.

**Key features:**
- Standard `pg.Pool` compatible with any PostgreSQL library or ORM
- Automatic OAuth token refresh (1-hour tokens, 2-minute refresh buffer)
- Token caching to minimize API calls
- Built-in OpenTelemetry instrumentation (query duration, pool connections, token refresh)

## Setting up Lakebase

Before using the plugin, you need to connect your Databricks App's service principal to your Lakebase database. The script below walks through the entire setup — fill in the variables at the top and run each section.

> **Note:** The Databricks CLI commands below use your **DEFAULT** profile. To use a different profile, set `export DATABRICKS_CONFIG_PROFILE=<profile-name>` before running the script.

Some values come from the Databricks UI:
- **Project ID** and **Branch ID** — from the URL when viewing your Lakebase branch: `.../projects/{project-id}/branches/{branch-id}/...`
- **PGHOST** — from the **Connect** dialog on your Lakebase branch
- **App name** — your Databricks App name (from `Compute > Apps`)

```sh
# ──────────────────────────────────────────────────
# 1. Set your variables
# ──────────────────────────────────────────────────
# From the branch URL: /projects/{id}/branches/{id}
PROJECT_ID=<your-project-id>
BRANCH_ID=<your-branch-id>

# From the Connect dialog on your Lakebase branch
PGHOST=<your-lakebase-host>
PGDATABASE=databricks_postgres

# Your Databricks App name
APP_NAME=<your-app-name>

# ──────────────────────────────────────────────────
# 2. Look up the endpoint via CLI
# ──────────────────────────────────────────────────
# Uses the first endpoint; branches typically have one
LAKEBASE_ENDPOINT=$(databricks postgres list-endpoints "projects/${PROJECT_ID}/branches/${BRANCH_ID}" | jq -r '.[0].name')
echo "Endpoint: ${LAKEBASE_ENDPOINT}"

# ──────────────────────────────────────────────────
# 3. Get your app's service principal
# ──────────────────────────────────────────────────
SP_CLIENT_ID=$(databricks apps get "${APP_NAME}" | jq -r '.service_principal_client_id')
echo "Service principal: ${SP_CLIENT_ID}"

# ──────────────────────────────────────────────────
# 4. Grant access to the service principal via psql
# ──────────────────────────────────────────────────
export PGSSLMODE=require
export PGPASSWORD=$(databricks postgres generate-database-credential "${LAKEBASE_ENDPOINT}" | jq -r '.token')

psql -h "${PGHOST}" -d "${PGDATABASE}" -U "$(databricks current-user me | jq -r '.userName')" <<"SQL"

CREATE EXTENSION IF NOT EXISTS databricks_auth;

DO $$
DECLARE
  sp TEXT := '${SP_CLIENT_ID}';
BEGIN
  -- Create service principal role (safe to re-run)
  PERFORM databricks_create_role(sp, 'SERVICE_PRINCIPAL');

  -- Connection and schema access
  EXECUTE format('GRANT CONNECT ON DATABASE "databricks_postgres" TO %I', sp);
  EXECUTE format('GRANT ALL ON SCHEMA public TO %I', sp);

  -- Privileges on existing objects
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', sp);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO %I', sp);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO %I', sp);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA public TO %I', sp);

  -- Default privileges on future objects you create
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', sp);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', sp);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO %I', sp);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO %I', sp);
END $$;

SQL

# ──────────────────────────────────────────────────
# 5. Verify the role was created
# ──────────────────────────────────────────────────
psql -h "${PGHOST}" -d "${PGDATABASE}" -U "$(databricks current-user me | jq -r '.userName')" \
  -c "SELECT rolname FROM pg_roles WHERE rolname = '${SP_CLIENT_ID}'"
```

## Basic usage

```ts
import { createApp, lakebase, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), lakebase()],
});
```

## Environment variables

The required environment variables:

| Variable | Description |
|---|---|
| `PGHOST` | Lakebase host |
| `PGDATABASE` | Database name |
| `LAKEBASE_ENDPOINT` | Endpoint resource path (e.g. `projects/.../branches/.../endpoints/...`) |
| `PGSSLMODE` | TLS mode — set to `require` |

Ensure that those environment variables are set both for local development (`.env` file) and for deployment (`app.yaml` file):

```yaml
env:
  - name: LAKEBASE_ENDPOINT
    value: projects/{project-id}/branches/{branch-id}/endpoints/primary
  - name: PGHOST
    value: {your-lakebase-host}
  - name: PGDATABASE
    value: databricks_postgres
  - name: PGSSLMODE
    value: require
```

For the full configuration reference (SSL, pool size, timeouts, logging, ORM examples), see the [`@databricks/lakebase` README](https://github.com/databricks/appkit/blob/main/packages/lakebase/README.md).

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

## Configuration options

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
