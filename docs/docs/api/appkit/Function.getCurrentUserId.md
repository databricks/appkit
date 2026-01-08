# Function: getCurrentUserId()

```ts
function getCurrentUserId(): string;
```

Defined in: [appkit/src/context/execution-context.ts:48](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/execution-context.ts#L48)

Get the current user ID for cache keying and telemetry.

Returns the user ID if in user context, otherwise the service user ID.

## Returns

`string`
