# @databricks/lakebase

PostgreSQL driver for Databricks Lakebase Autoscaling with automatic OAuth token refresh.

## Overview

`@databricks/lakebase` provides a drop-in replacement for the standard `pg` connection pool that automatically handles OAuth authentication for Databricks Lakebase Autoscaling (OLTP) databases.

It:

- Returns a standard `pg.Pool` - works with any PostgreSQL library or ORM
- Automatically refreshes OAuth tokens (1-hour lifetime, with 2-minute buffer)
- Caches tokens to minimize API calls
- Zero configuration with environment variables
- Optional OpenTelemetry instrumentation

**NOTE:** This package is NOT compatible with the Databricks Lakebase Provisioned.

## Installation

```bash
npm install @databricks/lakebase
```

## Quick Start

### Using Environment Variables

Set the following environment variables:

```bash
export PGHOST=your-lakebase-host.databricks.com
export PGDATABASE=your_database_name
export LAKEBASE_ENDPOINT=projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}
export PGUSER=your-service-principal-id
export PGSSLMODE=require
```

Then use the driver:

```typescript
import { createLakebasePool } from "@databricks/lakebase";

const pool = createLakebasePool();
const result = await pool.query("SELECT * FROM users");
console.log(result.rows);
```

### With Explicit Configuration

```typescript
import { createLakebasePool } from "@databricks/lakebase";

const pool = createLakebasePool({
  host: "your-lakebase-host.databricks.com",
  database: "your_database_name",
  endpoint:
    "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}",
  user: "service-principal-id", // Optional, defaults to DATABRICKS_CLIENT_ID
  max: 10, // Connection pool size
});
```

## Authentication

The driver supports Databricks authentication via:

1. **Default auth chain** (`.databrickscfg`, environment variables)
2. **Service principal** (`DATABRICKS_CLIENT_ID` + `DATABRICKS_CLIENT_SECRET`)
3. **OAuth tokens** (via Databricks SDK)

See [Databricks authentication docs](https://docs.databricks.com/en/dev-tools/auth/index.html) for configuration.

## Configuration

| Option                    | Environment Variable               | Description                                                              | Default       |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------ | ------------- |
| `host`                    | `PGHOST`                           | Lakebase host                                                            | _Required_    |
| `database`                | `PGDATABASE`                       | Database name                                                            | _Required_    |
| `endpoint`                | `LAKEBASE_ENDPOINT`                | Endpoint resource path                                                   | _Required_    |
| `user`                    | `PGUSER` or `DATABRICKS_CLIENT_ID` | Username or service principal ID                                         | Auto-detected |
| `port`                    | `PGPORT`                           | Port number                                                              | `5432`        |
| `sslMode`                 | `PGSSLMODE`                        | SSL mode (`require`, `disable`, `prefer`)                                | `require`     |
| `max`                     | -                                  | Max pool connections                                                     | `10`          |
| `idleTimeoutMillis`       | -                                  | Idle connection timeout                                                  | `30000`       |
| `connectionTimeoutMillis` | -                                  | Connection timeout                                                       | `10000`       |
| `telemetry`               | -                                  | Enable/disable telemetry (requires `@opentelemetry/api` to be installed) | `true`        |

## ORM Examples

### Drizzle ORM

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { createLakebasePool } from "@databricks/lakebase";

const pool = createLakebasePool();
const db = drizzle(pool);

const users = await db.select().from(usersTable);
```

### Prisma

```typescript
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createLakebasePool } from "@databricks/lakebase";

const pool = createLakebasePool();
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const users = await prisma.user.findMany();
```

### TypeORM

```typescript
import { DataSource } from "typeorm";
import { createLakebasePool } from "@databricks/lakebase";

const pool = createLakebasePool();

const dataSource = new DataSource({
  type: "postgres",
  synchronize: true,
  ...getLakebaseOrmConfig(),
  entities: [
    // Your entity classes
  ],
});

await dataSource.initialize();
```

### Sequelize

```typescript
import { Sequelize } from "sequelize";
import { getLakebaseOrmConfig } from "@databricks/lakebase";

const sequelize = new Sequelize({
  dialect: "postgres",
  ...getLakebaseOrmConfig(),
});
```

## OpenTelemetry instrumentation (optional)

The driver automatically instruments queries, token refresh operations, and connection pool metrics when [OpenTelemetry](https://opentelemetry.io/) is configured in your application.

### Install OpenTelemetry

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node
```

### Initialize OpenTelemetry

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK({
  // Your OTEL configuration
});

sdk.start();

// Now create your pool - it will automatically be instrumented
import { createLakebasePool } from "@databricks/lakebase";
const pool = createLakebasePool();
```

### Metrics Exported

- `lakebase.token.refresh.duration` - OAuth token refresh duration (histogram, ms)
- `lakebase.query.duration` - Query execution duration (histogram, ms)
- `lakebase.pool.connections.total` - Total connections in pool (gauge)
- `lakebase.pool.connections.idle` - Idle connections (gauge)
- `lakebase.pool.connections.waiting` - Clients waiting for connection (gauge)
- `lakebase.pool.errors` - Pool errors by error code (counter)

### Disable Telemetry

If you want to disable telemetry, you can do so by setting the `telemetry` option to `false`.
When the `@opentelemetry/api` package is not installed, telemetry will be disabled automatically.

```typescript
const pool = createLakebasePool({
  telemetry: false,
});
```

## Used in Databricks AppKit

This driver is also available as part of [@databricks/appkit](https://www.npmjs.com/package/@databricks/appkit):

```typescript
import { createLakebasePool } from "@databricks/appkit";
```

Both imports are identical - AppKit re-exports this package.

## Learn more about Lakebase Autoscaling

For Lakebase Autoscaling documentation, see [docs.databricks.com/aws/en/oltp/projects](https://docs.databricks.com/aws/en/oltp/projects/).
