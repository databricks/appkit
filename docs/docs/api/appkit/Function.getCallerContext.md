# Function: getCallerContext()

```ts
function getCallerContext(): CallerContext | undefined;
```

Get the caller context if one is active, otherwise `undefined`.
Unlike `getExecutionContext()`, this does not require `ServiceContext`
to be initialized and never throws.

## Returns

[`CallerContext`](Interface.CallerContext.md) \| `undefined`
