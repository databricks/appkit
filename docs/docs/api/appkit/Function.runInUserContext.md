# ~~Function: runInUserContext()~~

```ts
function runInUserContext<T>(userContext: 
  | UserContext
  | CallerContext & Pick<UserContext, "warehouseId">, fn: () => T): T;
```

## Type Parameters

| Type Parameter |
| ------ |
| `T` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `userContext` | \| [`UserContext`](TypeAlias.UserContext.md) \| [`CallerContext`](Interface.CallerContext.md) & `Pick`\<[`UserContext`](TypeAlias.UserContext.md), `"warehouseId"`\> |
| `fn` | () => `T` |

## Returns

`T`

## Deprecated

Use runInCallerContext.
