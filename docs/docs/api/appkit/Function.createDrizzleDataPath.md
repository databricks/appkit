# Function: createDrizzleDataPath()

```ts
function createDrizzleDataPath(pool: Pool, schema: Schema): DataPath;
```

Build a `DataPath` backed by `drizzle-orm/node-postgres`.

Sole `drizzle-orm` import site (decision #30) — swapping query builders
means rewriting only this file. `schema` resolves eager-loading relations
via a two-query pattern (parent + IN(ids)), avoiding N+1 without needing
Drizzle's `relations()` API.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `pool` | `Pool` |
| `schema` | [`Schema`](TypeAlias.Schema.md) |

## Returns

[`DataPath`](Interface.DataPath.md)
