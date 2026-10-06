# Type Alias: ExecutionResult\<T\>

```ts
type ExecutionResult<T> = 
  | {
  data: T;
  ok: true;
}
  | {
  error?: IdentityExpiredError;
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

## Type Declaration

```ts
{
  data: T;
  ok: true;
}
```

### data

```ts
data: T;
```

### ok

```ts
ok: true;
```

```ts
{
  error?: IdentityExpiredError;
  message: string;
  ok: false;
  status: number;
}
```

### error?

```ts
optional error: IdentityExpiredError;
```

Typed credential expiry without changing the existing failure envelope.

### message

```ts
message: string;
```

### ok

```ts
ok: false;
```

### status

```ts
status: number;
```
