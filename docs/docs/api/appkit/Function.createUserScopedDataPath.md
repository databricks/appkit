# Function: createUserScopedDataPath()

```ts
function createUserScopedDataPath(
   pool: Pool, 
   schema: Schema, 
   context: {
  userId: string;
}): DataPath;
```

User-scoped `DataPath`: each op runs in a txn with `SET LOCAL app.user_id`.

The txn is the security boundary — the GUC is txn-scoped, so a connection
returned to the pool can't leak identity to the next checkout. RLS policies
reading `current_setting('app.user_id')` resolve to the OBO user.

One SP pool services everyone (no per-user pools, OAuth refresh, or LRU).
Cost: one BEGIN+COMMIT per op; amortize via `transaction(fn)` for multi-step.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `pool` | `Pool` |
| `schema` | [`Schema`](TypeAlias.Schema.md) |
| `context` | \{ `userId`: `string`; \} |
| `context.userId` | `string` |

## Returns

[`DataPath`](Interface.DataPath.md)
