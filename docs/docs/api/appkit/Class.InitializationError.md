# Class: InitializationError

Error thrown when a service or component is not properly initialized.
Use when accessing services before they are ready.

## Example

```typescript
throw new InitializationError("CacheManager not initialized");
throw new InitializationError("ServiceContext not initialized. Call ServiceContext.initialize() first.");
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new InitializationError(message: string, options?: {
  cause?: Error;
  context?: Record<string, unknown>;
}): InitializationError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `context?`: `Record`\<`string`, `unknown`\>; \} |
| `options.cause?` | `Error` |
| `options.context?` | `Record`\<`string`, `unknown`\> |

#### Returns

`InitializationError`

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
readonly code: "INITIALIZATION_ERROR" = "INITIALIZATION_ERROR";
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
readonly statusCode: 500 = 500;
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

### migrationFailed()

```ts
static migrationFailed(cause?: Error): InitializationError;
```

Create an initialization error for migration failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cause?` | `Error` |

#### Returns

`InitializationError`

***

### notInitialized()

```ts
static notInitialized(serviceName: string, hint?: string): InitializationError;
```

Create an initialization error for a service that is not ready

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `serviceName` | `string` |
| `hint?` | `string` |

#### Returns

`InitializationError`

***

### setupFailed()

```ts
static setupFailed(component: string, cause?: Error): InitializationError;
```

Create an initialization error for setup failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `component` | `string` |
| `cause?` | `Error` |

#### Returns

`InitializationError`
