# Function: getLakebaseOrmConfig()

```ts
function getLakebaseOrmConfig(config?: Partial<LakebasePoolConfig>): {
  applicationName: string | undefined;
  connectTimeoutMS: number | undefined;
  dialectOptions: DefinedOnly<{
     application_name: string | undefined;
     connectionTimeoutMillis: number | undefined;
     idle_in_transaction_session_timeout?: number;
     keepAlive?: boolean;
     options?: string;
     query_timeout?: number;
     ssl:   | boolean
        | {
        rejectUnauthorized: boolean | undefined;
      };
     statement_timeout?: number | false;
  }>;
  extra: DefinedOnly<{
     idle_in_transaction_session_timeout?: number;
     idleTimeoutMillis: number | undefined;
     keepAlive?: boolean;
     maxLifetimeSeconds: number | undefined;
     options?: string;
     query_timeout?: number;
     statement_timeout?: number | false;
  }>;
  hooks: {
     afterConnect: (connection: unknown) => void;
  };
  password: string | () => string | () => Promise<string> | undefined;
  pool: DefinedOnly<{
     idle: number | undefined;
     max: number | undefined;
     validate: (connection?: unknown) => boolean;
  }>;
  poolSize: number | undefined;
  ssl:   | boolean
     | {
     rejectUnauthorized: boolean | undefined;
   };
  username: string | undefined;
};
```

Get Lakebase connection configuration for ORMs that don't accept pg.Pool directly.

Designed for ORMs like TypeORM and Sequelize that need connection parameters
rather than a pre-configured pool instance.

Returns connection config with field names compatible with common ORMs:
- `username` instead of `user`
- Simplified SSL config
- Password callback support for OAuth token refresh

Pool and client settings (connection lifetime, pool size, timeouts, SSL)
are also returned where each ORM reads them, so recycling works with both:
- TypeORM: pool size, connect timeout and application name under its own
  `poolSize`, `connectTimeoutMS` and `applicationName`, so values you set
  after the spread still win. Everything else (lifetime, idle timeout,
  statement and query timeouts) goes under `extra`, which TypeORM merges
  into the `pg.Pool` options last.
- Sequelize: `dialectOptions` (passed to each `pg.Client`), `pool`, and
  `hooks`. Sequelize's pool has no lifetime option, so connections are
  recycled by age through `pool.validate` and an `afterConnect` hook.

The result carries keys for both ORMs, and each ignores the other's:
Sequelize ignores `poolSize`, `connectTimeoutMS`, `applicationName` and
`extra`, and TypeORM ignores `dialectOptions`, `pool` and `hooks`.

If you set your own `extra`, `pool`,
`dialectOptions` or `hooks`, merge them with these instead of replacing
them, or those settings are lost. Replacing `hooks` makes lifetimes count
from a connection's first reuse instead of when it opened, and logs a
warning if you passed a `logger`. Nothing is logged without one.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config?` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> | Optional configuration (reads from environment if not provided) |

## Returns

```ts
{
  applicationName: string | undefined;
  connectTimeoutMS: number | undefined;
  dialectOptions: DefinedOnly<{
     application_name: string | undefined;
     connectionTimeoutMillis: number | undefined;
     idle_in_transaction_session_timeout?: number;
     keepAlive?: boolean;
     options?: string;
     query_timeout?: number;
     ssl:   | boolean
        | {
        rejectUnauthorized: boolean | undefined;
      };
     statement_timeout?: number | false;
  }>;
  extra: DefinedOnly<{
     idle_in_transaction_session_timeout?: number;
     idleTimeoutMillis: number | undefined;
     keepAlive?: boolean;
     maxLifetimeSeconds: number | undefined;
     options?: string;
     query_timeout?: number;
     statement_timeout?: number | false;
  }>;
  hooks: {
     afterConnect: (connection: unknown) => void;
  };
  password: string | () => string | () => Promise<string> | undefined;
  pool: DefinedOnly<{
     idle: number | undefined;
     max: number | undefined;
     validate: (connection?: unknown) => boolean;
  }>;
  poolSize: number | undefined;
  ssl:   | boolean
     | {
     rejectUnauthorized: boolean | undefined;
   };
  username: string | undefined;
}
```

ORM-compatible connection configuration

### applicationName

```ts
applicationName: string | undefined = pgConfig.application_name;
```

### connectTimeoutMS

```ts
connectTimeoutMS: number | undefined = pgConfig.connectionTimeoutMillis;
```

### dialectOptions

```ts
dialectOptions: DefinedOnly<{
  application_name: string | undefined;
  connectionTimeoutMillis: number | undefined;
  idle_in_transaction_session_timeout?: number;
  keepAlive?: boolean;
  options?: string;
  query_timeout?: number;
  ssl:   | boolean
     | {
     rejectUnauthorized: boolean | undefined;
   };
  statement_timeout?: number | false;
}>;
```

### extra

```ts
extra: DefinedOnly<{
  idle_in_transaction_session_timeout?: number;
  idleTimeoutMillis: number | undefined;
  keepAlive?: boolean;
  maxLifetimeSeconds: number | undefined;
  options?: string;
  query_timeout?: number;
  statement_timeout?: number | false;
}>;
```

### hooks

```ts
hooks: {
  afterConnect: (connection: unknown) => void;
};
```

#### hooks.afterConnect()

```ts
afterConnect: (connection: unknown) => void = lifetimeCheck.afterConnect;
```

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `connection` | `unknown` |

##### Returns

`void`

### password

```ts
password: string | () => string | () => Promise<string> | undefined;
```

### pool

```ts
pool: DefinedOnly<{
  idle: number | undefined;
  max: number | undefined;
  validate: (connection?: unknown) => boolean;
}>;
```

### poolSize

```ts
poolSize: number | undefined = pgConfig.max;
```

### ssl

```ts
ssl: 
  | boolean
  | {
  rejectUnauthorized: boolean | undefined;
} = ormSsl;
```

### username

```ts
username: string | undefined = user;
```

## Example

```typescript
// TypeORM
const dataSource = new DataSource({
  type: 'postgres',
  ...getLakebaseOrmConfig(),
  entities: [User],
  synchronize: true,
});

// Sequelize
const sequelize = new Sequelize({
  dialect: 'postgres',
  ...getLakebaseOrmConfig(),
  logging: false,
});

// Adding your own settings: merge, don't replace
const ormConfig = getLakebaseOrmConfig();
const sequelize = new Sequelize({
  dialect: 'postgres',
  ...ormConfig,
  pool: { ...ormConfig.pool, min: 2 },
});
```
