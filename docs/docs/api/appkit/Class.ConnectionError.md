# Class: ConnectionError

Error thrown when a connection or network operation fails.
Use for database pool errors, API failures, timeouts, etc.

## Example

```typescript
throw new ConnectionError("Query failed", { cause: pgError });
throw new ConnectionError("No response received from SQL Warehouse API");
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new ConnectionError(message: string, options?: {
  cause?: Error;
  context?: Record<string, unknown>;
}): ConnectionError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `context?`: `Record`\<`string`, `unknown`\>; \} |
| `options.cause?` | `Error` |
| `options.context?` | `Record`\<`string`, `unknown`\> |

#### Returns

`ConnectionError`

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`constructor`](Class.AppKitError.md#constructor)

## Properties

### cause?

```ts
readonly optional cause: Error;
```

Optional cause of the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`cause`](Class.AppKitError.md#cause)

***

### code

```ts
readonly code: "CONNECTION_ERROR" = "CONNECTION_ERROR";
```

Error code for programmatic error handling

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`code`](Class.AppKitError.md#code)

***

### context?

```ts
readonly optional context: Record<string, unknown>;
```

Additional context for the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`context`](Class.AppKitError.md#context)

***

### isRetryable

```ts
readonly isRetryable: true = true;
```

Whether this error type is generally safe to retry

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`isRetryable`](Class.AppKitError.md#isretryable)

***

### statusCode

```ts
readonly statusCode: 503 = 503;
```

HTTP status code suggestion (can be overridden)

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`statusCode`](Class.AppKitError.md#statuscode)

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Convert error to JSON for logging/serialization.
Sensitive values in context are automatically redacted.

#### Returns

`Record`\<`string`, `unknown`\>

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`toJSON`](Class.AppKitError.md#tojson)

***

### toString()

```ts
toString(): string;
```

Create a human-readable string representation

#### Returns

`string`

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`toString`](Class.AppKitError.md#tostring)

***

### apiFailure()

```ts
static apiFailure(service: string, cause?: Error): ConnectionError;
```

Create a connection error for API failures

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `service` | `string` |
| `cause?` | `Error` |

#### Returns

`ConnectionError`

***

### clientUnavailable()

```ts
static clientUnavailable(clientType: string, hint?: string): ConnectionError;
```

Create a connection error for client unavailable

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `clientType` | `string` |
| `hint?` | `string` |

#### Returns

`ConnectionError`

***

### poolError()

```ts
static poolError(operation: string, cause?: Error): ConnectionError;
```

Create a connection error for pool errors

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `cause?` | `Error` |

#### Returns

`ConnectionError`

***

### queryFailed()

```ts
static queryFailed(cause?: Error): ConnectionError;
```

Create a connection error for query failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cause?` | `Error` |

#### Returns

`ConnectionError`

***

### transactionFailed()

```ts
static transactionFailed(cause?: Error): ConnectionError;
```

Create a connection error for transaction failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cause?` | `Error` |

#### Returns

`ConnectionError`
