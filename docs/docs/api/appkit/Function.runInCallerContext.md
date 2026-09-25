# Function: runInCallerContext()

```ts
function runInCallerContext<T>(callerContext: CallerContext, fn: () => T): T;
```

Run a function with an immutable snapshot of the caller context.
Nested and concurrent scopes keep their own identities.

## Type Parameters

| Type Parameter |
| ------ |
| `T` |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `callerContext` | [`CallerContext`](Interface.CallerContext.md) | The caller context to use |
| `fn` | () => `T` | The function to run |

## Returns

`T`

The result of the function
