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
optional workspaceClient: WorkspaceClient;
```

Databricks workspace client for OAuth authentication
If not provided along with endpoint, will attempt to use ServiceContext

Note: If password is provided, OAuth auth is not used
