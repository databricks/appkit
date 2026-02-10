# Function: createLakebasePool()

```ts
function createLakebasePool(config?: Partial<LakebasePoolConfig>): Pool;
```

Create a PostgreSQL connection pool with automatic OAuth token refresh for Lakebase.

This function returns a standard `pg.Pool` instance configured with a password callback
that automatically fetches and caches OAuth tokens from Databricks. The returned pool
works with any ORM or library that accepts a `pg.Pool` (Drizzle, Prisma, TypeORM, etc.).

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config?` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> | Configuration options (optional, reads from environment if not provided) |

## Returns

`Pool`

Standard pg.Pool instance with OAuth token refresh

## See

https://docs.databricks.com/aws/en/oltp/projects/authentication

## Examples

```typescript
// Set: PGHOST, PGDATABASE, LAKEBASE_ENDPOINT
const pool = createLakebasePool();
const result = await pool.query('SELECT * FROM users');
```

```typescript
// Format: projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}
// Note: Use actual IDs from Databricks (project-id is a UUID)
const pool = createLakebasePool({
  endpoint: 'projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0',
  host: 'ep-abc.databricks.com',
  database: 'databricks_postgres',
  user: 'service-principal-id'
});
```

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
const pool = createLakebasePool();
const db = drizzle({ client: pool });
```

```typescript
import { PrismaPg } from '@prisma/adapter-pg';
const pool = createLakebasePool();
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
```
