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

### claims?

```ts
optional claims: RequestedClaims[];
```

Optional UC claims for fine-grained Unity Catalog table permissions on the
generated Postgres token.

***

### earlyRefreshMs?

```ts
optional earlyRefreshMs: number;
```

How long before token expiry to refresh, in milliseconds.

#### Default

```ts
120000 (2 minutes)
```

***

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

### refresh?

```ts
optional refresh: RefreshMode;
```

Token refresh strategy.

- `"eager"` (default): fetch a token immediately and refresh it in the
  background before it expires. Best for time-sensitive, user-facing apps.
- `"lazy"`: fetch a token on first use and refresh it on demand.

#### Default

```ts
"eager"
```

***

### retry?

```ts
optional retry: RetryOptions;
```

Retry options for transient credential-fetch failures (e.g. the OAuth
server being briefly unreachable).

#### Default

```ts
{ schedule: [50, 500, 5000] }
```

***

### sslMode?

```ts
optional sslMode: "verify-full" | "verify-ca" | "require" | "prefer" | "disable";
```

SSL mode for the connection (convenience helper).
Can also be set via PGSSLMODE environment variable.
All values other than "disable" are treated as "verify-full" against system
root certs.

#### Default

```ts
"verify-full"
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
