# Function: getExecutionContext()

```ts
function getExecutionContext(): 
  | ServiceContextState
  | CallerContext & UserContext;
```

Get the current execution context.

- If running inside a caller context (via asUser), returns the caller context
- Otherwise, returns the service context

## Returns

  \| `ServiceContextState`
  \| [`CallerContext`](Interface.CallerContext.md) & `UserContext`

## Throws

Error if ServiceContext is not initialized
