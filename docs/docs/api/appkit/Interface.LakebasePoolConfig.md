# Interface: LakebasePoolConfig

Configuration for creating a Lakebase connection pool

Supports two authentication methods:
1. OAuth token authentication - Provide workspaceClient + endpoint (automatic token rotation)
2. Native Postgres password authentication - Provide password string or function

Extends pg.PoolConfig to support all standard PostgreSQL pool options.

## See

https://docs.databricks.com/aws/en/oltp/projects/authentication

## Extends

- `PoolConfig`

## Properties

### endpoint?

```ts
optional endpoint: string;
```

Endpoint resource path for OAuth token generation.

Retrieve the value using the Databricks CLI:
```
databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}
```
Use the `name` field from the output.

Required for OAuth authentication (unless password is provided)
Can also be set via LAKEBASE_ENDPOINT environment variable

#### Example

```ts
"projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}"
```

***

### logger?

```ts
optional logger: Logger | LoggerConfig;
```

Optional logger configuration.

Supports three modes:
1. Logger instance - Use your own logger implementation
2. LoggerConfig - Enable/disable specific log levels (uses console)
3. Undefined - Defaults to error logging only

#### Examples

```typescript
import { createLogger } from '@databricks/appkit';
const pool = createLakebasePool({
  logger: createLogger('connectors:lakebase')
});
```

```typescript
const pool = createLakebasePool({
  logger: { debug: true, info: true, error: true }
});
```

***

### maxLifetimeSeconds?

```ts
optional maxLifetimeSeconds: number;
```

Maximum time, in seconds, a connection may stay open before the pool
closes it and opens a new one. Passed to `pg.Pool`.

Lakebase checks the OAuth token only when a connection opens, and access
granted through Unity Catalog claims in the token can stop working on a
connection that stays open for hours. Recycling connections keeps that
from happening. Values up to 9000 (2.5 hours) are safe; larger values, and
`0` (never recycle), log a warning. A negative or non-numeric value, or
one above 2147483 (about 24.8 days, the longest timer Node supports), logs
a warning and the default is used instead.

pg-pool recycles only idle connections: a client you check out and hold
isn't closed until you release it.

#### Default

```ts
1800 (30 minutes)
```

#### Overrides

```ts
PoolConfig.maxLifetimeSeconds
```

***

### sslMode?

```ts
optional sslMode: "require" | "disable" | "prefer";
```

SSL mode for the connection (convenience helper)
Can also be set via PGSSLMODE environment variable

#### Default

```ts
"require"
```

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

Telemetry configuration

- `true` or omitted: enable all telemetry (traces, metrics) -- no-op when OTEL is not configured
- `false`: disable all telemetry
- `{ traces?, metrics? }`: fine-grained control

***

### workspaceClient?

```ts
optional workspaceClient: LakebaseWorkspaceClient;
```

Databricks workspace client for OAuth authentication
If not provided along with endpoint, will attempt to use ServiceContext

Note: If password is provided, OAuth auth is not used
