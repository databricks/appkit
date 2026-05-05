# Function: createLakebasePoolManager()

```ts
function createLakebasePoolManager(baseConfig?: Partial<LakebasePoolConfig>): LakebasePoolManager;
```

Create a pool manager that maintains per-key Lakebase connection pools.

Each pool is created via `createLakebasePool` with the base config merged
with per-pool overrides (e.g. a user's `workspaceClient` and `user`).

A periodic cleanup removes empty Pool objects (where all connections have
been closed by pg's built-in `idleTimeoutMillis`) from the internal Map.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `baseConfig?` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> |

## Returns

[`LakebasePoolManager`](Interface.LakebasePoolManager.md)

## Example

```typescript
const poolManager = createLakebasePoolManager();

// In a route handler:
const userPool = poolManager.getPool(userName, {
  workspaceClient: new WorkspaceClient({ token: userToken, host, authType: "pat" }),
  user: userName,
});
const result = await userPool.query("SELECT * FROM products");
```
