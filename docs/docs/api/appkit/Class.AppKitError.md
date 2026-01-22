# Abstract Class: AppKitError

Defined in: appkit/src/errors/base.ts:33

Base error class for all AppKit errors.
Provides a consistent structure for error handling across the framework.

## Example

```typescript
// Catching errors by type
try {
  await lakebase.query("...");
} catch (e) {
  if (e instanceof AuthenticationError) {
    // Re-authenticate
  } else if (e instanceof ConnectionError && e.isRetryable) {
    // Retry with backoff
  }
}

// Logging errors
console.error(error.toJSON()); // Safe for logging, sensitive values redacted
```

## Extends

- `Error`

## Extended by

- [`AuthenticationError`](Class.AuthenticationError.md)
- [`ConfigurationError`](Class.ConfigurationError.md)
- [`ConnectionError`](Class.ConnectionError.md)
- [`ExecutionError`](Class.ExecutionError.md)
- [`InitializationError`](Class.InitializationError.md)
- [`ServerError`](Class.ServerError.md)
- [`TunnelError`](Class.TunnelError.md)
- [`ValidationError`](Class.ValidationError.md)

## Constructors

### Constructor

```ts
new AppKitError(message: string, options?: {
  cause?: Error;
  context?: Record<string, unknown>;
}): AppKitError;
```

Defined in: appkit/src/errors/base.ts:49

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `context?`: `Record`\<`string`, `unknown`\>; \} |
| `options.cause?` | `Error` |
| `options.context?` | `Record`\<`string`, `unknown`\> |

#### Returns

`AppKitError`

#### Overrides

```ts
Error.constructor
```

## Properties

### cause?

```ts
readonly optional cause: Error;
```

Defined in: appkit/src/errors/base.ts:44

Optional cause of the error

***

### code

```ts
abstract readonly code: string;
```

Defined in: appkit/src/errors/base.ts:35

Error code for programmatic error handling

***

### context?

```ts
readonly optional context: Record<string, unknown>;
```

Defined in: appkit/src/errors/base.ts:47

Additional context for the error

***

### isRetryable

```ts
abstract readonly isRetryable: boolean;
```

Defined in: appkit/src/errors/base.ts:41

Whether this error type is generally safe to retry

***

### statusCode

```ts
abstract readonly statusCode: number;
```

Defined in: appkit/src/errors/base.ts:38

HTTP status code suggestion (can be overridden)

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Defined in: appkit/src/errors/base.ts:68

Convert error to JSON for logging/serialization.
Sensitive values in context are automatically redacted.

#### Returns

`Record`\<`string`, `unknown`\>

***

### toString()

```ts
toString(): string;
```

Defined in: appkit/src/errors/base.ts:84

Create a human-readable string representation

#### Returns

`string`
