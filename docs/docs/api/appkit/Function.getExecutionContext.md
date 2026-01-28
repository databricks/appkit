# Function: getExecutionContext()

```ts
function getExecutionContext(): ExecutionContext;
```

Defined in: [appkit/src/context/execution-context.ts:35](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/execution-context.ts#L35)

Get the current execution context.

- If running inside a user context (via asUser), returns the user context
- Otherwise, returns the service context

## Returns

`ExecutionContext`

## Throws

Error if ServiceContext is not initialized
