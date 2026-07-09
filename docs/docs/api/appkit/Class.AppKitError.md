# Abstract Class: AppKitError

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
  clientMessage?: string;
  context?: Record<string, unknown>;
}): AppKitError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `clientMessage?`: `string`; `context?`: `Record`\<`string`, `unknown`\>; \} |
| `options.cause?` | `Error` |
| `options.clientMessage?` | `string` |
| `options.context?` | `Record`\<`string`, `unknown`\> |

#### Returns

`AppKitError`

#### Overrides

```ts
Error.constructor
```

## Properties

### \_clientMessage?

```ts
protected readonly optional _clientMessage: string;
```

Client-safe error message. When set, callers serializing the error to
a client (SSE, HTTP body) MUST prefer `clientMessage` over `message`
— `message` may contain raw upstream / SDK text including statement
fragments, internal object names, and correlation IDs.

Subclasses can set this in their constructor for a fixed sanitized
string. When unset, `clientMessage` defaults to a generic per-code
string (see the getter), and the raw `message` is kept server-side
only.

***

### cause?

```ts
readonly optional cause: Error;
```

Optional cause of the error

#### Overrides

```ts
Error.cause
```

***

### code

```ts
abstract readonly code: string;
```

Error code for programmatic error handling

***

### context?

```ts
readonly optional context: Record<string, unknown>;
```

Additional context for the error

***

### isRetryable

```ts
abstract readonly isRetryable: boolean;
```

Whether this error type is generally safe to retry

***

### statusCode

```ts
abstract readonly statusCode: number;
```

HTTP status code suggestion (can be overridden)

## Accessors

### clientMessage

#### Get Signature

```ts
get clientMessage(): string;
```

Sanitized message safe to forward to clients. Override in subclasses
if a more specific default is appropriate.

##### Returns

`string`

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Convert error to JSON for logging/serialization.
Sensitive values in context are automatically redacted.

#### Returns

`Record`\<`string`, `unknown`\>

***

### toString()

```ts
toString(): string;
```

Create a human-readable string representation

#### Returns

`string`
