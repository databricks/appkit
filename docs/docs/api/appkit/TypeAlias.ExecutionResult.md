# Type Alias: ExecutionResult\<T\>

```ts
type ExecutionResult<T> = 
  | {
  data: T;
  ok: true;
}
  | {
  message: string;
  ok: false;
  status: number;
};
```

Discriminated union for plugin execution results.

Replaces the previous `T | undefined` return type on `execute()`.

On failure, the HTTP status code is preserved from:
- `AppKitError` subclasses (via `statusCode`)
- Any `Error` with a numeric `statusCode` property (e.g. `ApiError`)
- All other errors default to status 500

In production, error messages from non-AppKitError sources are handled as:
- 4xx errors: original message is preserved (client-facing by design)
- 5xx errors: replaced with "Server error" to prevent information leakage

## Type Parameters

| Type Parameter |
| ------ |
| `T` |
