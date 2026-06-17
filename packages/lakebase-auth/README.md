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

Set `PGHOST`, `PGDATABASE`, `LAKEBASE_ENDPOINT`, and (optionally) `PGUSER`, then:

```typescript
import pg from "pg";
import { getPgConfig } from "@databricks/lakebase-auth";

const { dispose, ...config } = getPgConfig();
const pool = new pg.Pool(config);

const result = await pool.query("SELECT * FROM users");

// On shutdown, stop the background token refresh:
await pool.end();
dispose();
```

To find your `LAKEBASE_ENDPOINT`, run the Databricks CLI and use the `name` field:

```bash
databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}
```

## Usage with other drivers

`getPgConfig()` returns `host`, `port`, `user`, `database`, `password`, `ssl`, and `dispose`. Map the field names to your driver of choice:

```typescript
// postgres.js (uses `username`)
import postgres from "postgres";
const { host, port, user, database, password, ssl } = getPgConfig();
const sql = postgres({ host, port, username: user, database, password, ssl });

// Bun.SQL (uses `hostname`, `username`, `tls`)
const cfg = getPgConfig();
const sql = new Bun.SQL({
  hostname: cfg.host,
  port: cfg.port,
  username: cfg.user,
  database: cfg.database,
  password: cfg.password,
  tls: true,
});
```

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

Transient credential-fetch failures (e.g. the OAuth server being briefly unreachable) are retried automatically. The default schedule is `[50, 500, 5000]` ms (three retries, then a final attempt). Customize or disable it:

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
| `endpoint`       | `LAKEBASE_ENDPOINT`                | Endpoint resource path               | _Required_ (OAuth) |
| `user`           | `PGUSER` or `DATABRICKS_CLIENT_ID` | Username or service principal ID     | _Required_         |
| `port`           | `PGPORT`                           | Port number                          | `5432`             |
| `sslMode`        | `PGSSLMODE`                        | SSL mode                             | `require`          |
| `refresh`        | -                                  | `"eager"` or `"lazy"`                | `"eager"`          |
| `earlyRefreshMs` | -                                  | How long before expiry to refresh    | `120000`           |
| `retry`          | -                                  | Retry schedule for credential fetch  | `[50, 500, 5000]`  |

## Learn more

For Lakebase Autoscaling documentation, see [docs.databricks.com/aws/en/oltp/projects](https://docs.databricks.com/aws/en/oltp/projects/).
