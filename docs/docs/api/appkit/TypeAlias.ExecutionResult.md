# Type Alias: ExecutionResult\<T\>

```ts
type ExecutionResult<T> = 
  | {
  data: T;
  ok: true;
}
  | {
  code?: string;
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

The optional `code` is a stable, machine-readable discriminator that is
safe to expose to clients. Unlike `message`, it is NEVER masked in
production, so consumers must branch on `code` (not on message text) to
recover error semantics. It is derived from, in priority order:
- `"ABORTED"` for errors with `name === "AbortError"` (e.g. `DOMException`)
- `AppKitError.code` (e.g. `"EXECUTION_CANCELED"`, `"EXECUTION_ERROR"`)
- The error's `name` for any other `Error`

## Type Parameters

| Type Parameter |
| ------ |
| `T` |
