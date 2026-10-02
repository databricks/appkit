# ~~Function: getUserContext()~~

```ts
function getUserContext(): 
  | CallerContext & UserContext
  | undefined;
```

## Returns

  \| [`CallerContext`](Interface.CallerContext.md) & [`UserContext`](TypeAlias.UserContext.md)
  \| `undefined`

## Deprecated

Use getCallerContext and its principal field.
