# Function: getExecutionContext()

```ts
function getExecutionContext(): ExecutionContext;
```

Get the current execution context.

- If running inside a user context (via asUser), returns the user context
- Otherwise, returns the service context

## Returns

`ExecutionContext`

## Throws

Error if ServiceContext is not initialized
