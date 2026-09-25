# ~~Function: isUserContext()~~

```ts
function isUserContext(ctx: ExecutionContext): ctx is UserContext & Partial<CallerContext>;
```

## Parameters

| Parameter | Type |
| ------ | ------ |
| `ctx` | [`ExecutionContext`](TypeAlias.ExecutionContext.md) |

## Returns

`ctx is UserContext & Partial<CallerContext>`

## Deprecated

Use isCallerContext. Active caller contexts retain the legacy
identity accessors for callers narrowed by this guard.
