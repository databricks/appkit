# @databricks/lakebase-auth

OAuth credential generation and token refresh for Databricks Lakebase Autoscaling, usable with any PostgreSQL driver.

## Overview

`@databricks/lakebase-auth` produces a Postgres connection config (including an auto-refreshing OAuth password callback) for Databricks Lakebase Autoscaling (OLTP) databases. It is dependency-light (only the Databricks SDK) and driver-agnostic, so it works with [`pg`](https://node-postgres.com/), [`postgres.js`](https://github.com/porsager/postgres), [`Bun.SQL`](https://bun.sh/docs/api/sql), and any ORM built on top of them.

It:

- Generates time-limited Lakebase OAuth tokens via the Databricks SDK (full auth chain: `.databrickscfg`, PAT, OAuth M2M, env vars)
- Refreshes tokens automatically — **eagerly** in the background by default, or **lazily** on demand
- Retries transient credential-fetch failures
- Has no `pg` or OpenTelemetry dependency

For a batteries-included `pg.Pool` with OpenTelemetry instrumentation and AppKit integration, use [`@databricks/lakebase`](https://www.npmjs.com/package/@databricks/lakebase), which builds on this package.

**NOTE:** This package is NOT compatible with Databricks Lakebase Provisioned.

## Installation

```bash
npm install @databricks/lakebase-auth
```

## Quick Start

Ensure Databricks credentials are available, for example in `.databrickscfg` or by setting `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, and `DATABRICKS_CLIENT_SECRET`.

Set the following environment variables:

```bash
export PGHOST=your-lakebase-host.databricks.com
export PGDATABASE=your_database_name
export LAKEBASE_ENDPOINT=projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-broad-pine-y12n6gnv/endpoints/ep-summer-frost-y131l3vx
export PGUSER=your_user # optional: defaults to DATABRICKS_CLIENT_ID
```

Your `LAKEBASE_ENDPOINT` has the structure `projects/${project}/branches/${branch}/endpoints/${endpoint}`. To find it, run the Databricks CLI and use the `name` field:

```bash
databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}
```

You can obtain the Project ID and Branch ID from the Lakebase Autoscaling UI, like the "Branch Overview" page (Project list -> Project dashboard -> Branch overview). 

Then use with node-postgres:

```typescript
import pg from "pg";
import { getPgConfig } from "@databricks/lakebase-auth";

const { dispose, ...config } = getPgConfig();
const pool = new pg.Pool(config);

const result = await pool.query("SELECT * FROM users");

// on shutdown, stop the background token refresh:
await pool.end();
dispose();
```

## Usage with other drivers

`getPgConfig()` returns `host`, `port`, `user`, `database`, `password` (a function returning a current OAuth token), `ssl`, and `dispose`. These are accepted by postgres.js and Bun.sql as well as pg:

```typescript
// postgres.js
import postgres from "postgres";
const { dispose, ...config } = getPgConfig();
const sql = postgres({
  ...config,
  // any custom options or overrides here
});
const result = await sql`SELECT now()`
await sql.end();
dispose(); // stop background token refresh

// Bun.SQL
const { dispose, ...config } = getPgConfig();
const sql = new Bun.SQL({
  ...config,
  // any custom options or overrides here
});
const result = await sql`SELECT now()`;
await sql.end();
dispose(); // stop background token refresh
```

The emitted `ssl` object carries a `serverName` for `Bun.SQL`, which [fails to derive SNI from the host](https://github.com/oven-sh/bun/issues/26369) when TLS is passed as an object. Lakebase requires SNI, so this makes Bun connections work; `pg` and `postgres.js` set SNI themselves and ignore the key.

### Low-level password provider

If you only need the password callback (and manage the rest of the connection yourself), use `createPasswordProvider`:

```typescript
import { createPasswordProvider } from "@databricks/lakebase-auth";

const { password, dispose } = createPasswordProvider({
  endpoint: process.env.LAKEBASE_ENDPOINT,
});

const pool = new pg.Pool({ host, user, database, password });
// on shutdown: await pool.end(); dispose();
```

## Token refresh strategies

| Mode             | When the token is fetched/refreshed                                  | Best for                                  |
| ---------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `"eager"` (default) | Immediately on creation, then in the background before each expiry | Time-sensitive, user-facing apps and APIs |
| `"lazy"`         | On first use, then on demand when the token nears expiry             | Background jobs, infrequent connections   |

```typescript
const config = getPgConfig({ refresh: "lazy" });
```

Eager refresh uses an `unref`'d timer, so it never keeps the process alive on its own. Call `dispose()` to cancel it during graceful shutdown.

## Retries

Transient credential-fetch failures (e.g. the OAuth server being briefly unreachable) are retried automatically. The default schedule is `[50, 500, 5000]` ms (i.e. an initial attempt plus three retries with backoff). Customize or disable it:

```typescript
// custom backoff
getPgConfig({ retry: { schedule: [100, 1000] } });

// disable retries
getPgConfig({ retry: { schedule: [] } });
```

## Logging

The package emits log events through an optional `onLog` callback (no logging dependency):

```typescript
getPgConfig({
  onLog: (level, message, ...args) => console[level](message, ...args),
});
```

## Configuration

| Option           | Environment Variable               | Description                          | Default            |
| ---------------- | ---------------------------------- | ------------------------------------ | ------------------ |
| `host`           | `PGHOST`                           | Lakebase host                        | _Required_         |
| `database`       | `PGDATABASE`                       | Database name                        | _Required_         |
| `endpoint`       | `LAKEBASE_ENDPOINT`                | Endpoint resource path               | _Required_         |
| `user`           | `PGUSER` or `DATABRICKS_CLIENT_ID` | Username or service principal ID     | _Required_         |
| `port`           | `PGPORT`                           | Port number                          | `5432`             |
| `sslMode`        | `PGSSLMODE`                        | SSL mode                             | `require`          |
| `refresh`        | -                                  | `"eager"` or `"lazy"`                | `"eager"`          |
| `earlyRefreshMs` | -                                  | How long before expiry to refresh    | `120000`           |
| `retry`          | -                                  | Retry schedule for credential fetch  | `[50, 500, 5000]`  |

## Learn more

For Lakebase Autoscaling documentation, see [docs.databricks.com/aws/en/oltp/projects](https://docs.databricks.com/aws/en/oltp/projects/).
