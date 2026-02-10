# Function: getLakebaseOrmConfig()

```ts
function getLakebaseOrmConfig(config?: Partial<LakebasePoolConfig>): {
  password: string | () => string | () => Promise<string> | undefined;
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

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config?` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> | Optional configuration (reads from environment if not provided) |

## Returns

```ts
{
  password: string | () => string | () => Promise<string> | undefined;
  ssl:   | boolean
     | {
     rejectUnauthorized: boolean | undefined;
   };
  username: string | undefined;
}
```

ORM-compatible connection configuration

### password

```ts
password: string | () => string | () => Promise<string> | undefined;
```

### ssl

```ts
ssl: 
  | boolean
  | {
  rejectUnauthorized: boolean | undefined;
};
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
```
