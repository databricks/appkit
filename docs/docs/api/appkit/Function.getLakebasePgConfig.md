# Function: getLakebasePgConfig()

```ts
function getLakebasePgConfig(
   config?: Partial<LakebasePoolConfig>, 
   telemetry?: DriverTelemetry, 
   logger?: Logger): PoolConfig;
```

Get Lakebase connection configuration for PostgreSQL clients.

Returns pg.PoolConfig with OAuth token authentication configured.
Best used with pg.Pool directly or ORMs that accept pg.Pool instances (like Drizzle).

For ORMs that need connection parameters (TypeORM, Sequelize), use getLakebaseOrmConfig() instead.

Used internally by createLakebasePool().

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config?` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> | Optional configuration (reads from environment if not provided) |
| `telemetry?` | `DriverTelemetry` | Optional pre-initialized telemetry (created internally if not provided) |
| `logger?` | `Logger` | Optional logger (silent if not provided) |

## Returns

`PoolConfig`

PostgreSQL pool configuration with OAuth token refresh
