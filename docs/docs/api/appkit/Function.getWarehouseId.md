# Function: getWarehouseId()

```ts
function getWarehouseId(): Promise<string>;
```

Get the configured SQL warehouse ID after app initialization.
The warehouse is an app resource; SP and caller executions use the same binding.
Deprecated user-context scopes retain support for explicit warehouse overrides.

## Returns

`Promise`\<`string`\>

## Throws

ConfigurationError if no SQL warehouse was required at startup.

## Throws

InitializationError if the app resources are not initialized.
