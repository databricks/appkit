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
export LAKEBASE_ENDPOINT=projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-broad-pine-y12n6gnv/endpoints/ep-summer-frost-y131l3vx
export PGUSER=your_user # optionally, defaults to DATABRICKS_CLIENT_ID
export PGSSLMODE=require
```

To find your `LAKEBASE_ENDPOINT`, run the Databricks CLI and use the `name` field from the output:

```bash
databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}
```

You can obtain the Project ID and Branch ID from the Lakebase Autoscaling UI, like the "Branch Overview" page. (Project list -> Project dashboard -> Branch overview). When using the driver as a part of Databricks Apps, the `LAKEBASE_ENDPOINT` is automatically injected using `fromValue`:

```yaml
env:
  - name: LAKEBASE_ENDPOINT
    valueFrom: database # Lakebase Autoscaling database resource name
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
  host: "your-lakebase-host.databricks.com", // defaults to PGHOST environment variable
  database: "your_database_name", // defaults to PGDATABASE environment variable
  endpoint:
    "projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-broad-pine-y12n6gnv/endpoints/ep-summer-frost-y131l3vx", // defaults to LAKEBASE_ENDPOINT environment variable
  user: "user_id", // Optional, defaults to PGUSER or DATABRICKS_CLIENT_ID
  max: 10, // Connection pool size
});
```

## Authentication

The driver supports Databricks authentication via:

1. **Default auth chain** (`.databrickscfg`, environment variables)
2. **OAuth tokens** (via Databricks SDK)
3. **Native Postgres password authentication**

See [Databricks authentication docs](https://docs.databricks.com/en/dev-tools/auth/index.html) or [Lakebase Autoscaling authentication docs](https://docs.databricks.com/aws/en/oltp/projects/authentication#overview) for more information.

## Configuration

| Option                    | Environment Variable               | Description                             | Default                 |
| ------------------------- | ---------------------------------- | --------------------------------------- | ----------------------- |
| `host`                    | `PGHOST`                           | Lakebase host                           | _Required_              |
| `database`                | `PGDATABASE`                       | Database name                           | _Required_              |
| `endpoint`                | `LAKEBASE_ENDPOINT`                | Endpoint resource path                  | _Required_              |
| `user`                    | `PGUSER` or `DATABRICKS_CLIENT_ID` | Username or service principal ID        | Auto-detected           |
| `port`                    | `PGPORT`                           | Port number                             | `5432`                  |
| `sslMode`                 | `PGSSLMODE`                        | SSL mode                                | `require`               |
| `max`                     | -                                  | Max pool connections                    | `10`                    |
| `idleTimeoutMillis`       | -                                  | Idle connection timeout                 | `30000`                 |
| `connectionTimeoutMillis` | -                                  | Connection timeout                      | `10000`                 |
| `logger`                  | -                                  | Logger instance or config               | `{ error: true }`       |

## Logging

By default, the driver logs errors only. You can configure logging in three ways:

### 1. Config-Based Logger (Simple)

Enable/disable specific log levels using boolean flags:

```typescript
import { createLakebasePool } from "@databricks/lakebase";

// Development mode: enable debug and error logs
const pool = createLakebasePool({
  logger: { debug: true, error: true },
});

// Production mode: errors only (same as default)
const pool = createLakebasePool({
  logger: { error: true },
});

// Verbose mode: all logs enabled
const pool = createLakebasePool({
  logger: { debug: true, info: true, warn: true, error: true },
});

// Silent mode: all logs disabled
const pool = createLakebasePool({
  logger: { debug: false, info: false, warn: false, error: false },
});
```

### 2. Custom Logger (Advanced)

Inject your own logger implementation for custom formatting or integrations:

```typescript
const logger = {
  debug: (msg: string, ...args: unknown[]) => console.debug(msg, ...args),
  info: (msg: string, ...args: unknown[]) => console.log(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
};

const pool = createLakebasePool({ logger });
```

### 3. Default Behavior

If no logger is provided, the driver defaults to error-only logging:

```typescript
// These are equivalent:
const pool1 = createLakebasePool();
const pool2 = createLakebasePool({ logger: { error: true } });
```

When used with AppKit, logging is automatically configured - see the [AppKit Integration](#appkit-integration) section.

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

## OpenTelemetry Integration

The driver automatically uses OpenTelemetry's global registry when available. If your application initializes OpenTelemetry providers, the driver will automatically instrument queries and metrics with no additional configuration needed.

### Setup

Install OpenTelemetry in your application:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node
```

Initialize OpenTelemetry in your application:

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK({
  // Your OTEL configuration
});

sdk.start(); // Registers global providers

// Now create your pool - it automatically uses the global providers
import { createLakebasePool } from "@databricks/lakebase";
const pool = createLakebasePool();
```

The driver calls `trace.getTracer('@databricks/lakebase')` and `metrics.getMeter('@databricks/lakebase')` internally. If no global providers are registered, operations are automatic no-ops.

### Metrics Exported

- `lakebase.token.refresh.duration` - OAuth token refresh duration (histogram, ms)
- `lakebase.query.duration` - Query execution duration (histogram, ms)
- `lakebase.pool.connections.total` - Total connections in pool (gauge)
- `lakebase.pool.connections.idle` - Idle connections (gauge)
- `lakebase.pool.connections.waiting` - Clients waiting for connection (gauge)
- `lakebase.pool.errors` - Pool errors by error code (counter)

## AppKit Integration

This driver is also available as part of [@databricks/appkit](https://www.npmjs.com/package/@databricks/appkit):

```typescript
import { createLakebasePool } from "@databricks/appkit";

const pool = createLakebasePool();
```

**Differences between standalone and AppKit:**

- **Standalone** (`@databricks/lakebase`): Silent by default - no logger configured
- **AppKit** (`@databricks/appkit`): Automatically injects AppKit's logger with scope `appkit:connectors:lakebase`.

## Learn more about Lakebase Autoscaling

For Lakebase Autoscaling documentation, see [docs.databricks.com/aws/en/oltp/projects](https://docs.databricks.com/aws/en/oltp/projects/).
