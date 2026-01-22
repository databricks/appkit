# Class: InitializationError

Defined in: [appkit/src/errors/initialization.ts:13](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/initialization.ts#L13)

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

Defined in: [appkit/src/errors/base.ts:49](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L49)

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

Defined in: [appkit/src/errors/base.ts:44](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L44)

Optional cause of the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`cause`](Class.AppKitError.md#cause)

***

### code

```ts
readonly code: "INITIALIZATION_ERROR" = "INITIALIZATION_ERROR";
```

Defined in: [appkit/src/errors/initialization.ts:14](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/initialization.ts#L14)

Error code for programmatic error handling

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`code`](Class.AppKitError.md#code)

***

### context?

```ts
readonly optional context: Record<string, unknown>;
```

Defined in: [appkit/src/errors/base.ts:47](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L47)

Additional context for the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`context`](Class.AppKitError.md#context)

***

### isRetryable

```ts
readonly isRetryable: true = true;
```

Defined in: [appkit/src/errors/initialization.ts:16](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/initialization.ts#L16)

Whether this error type is generally safe to retry

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`isRetryable`](Class.AppKitError.md#isretryable)

***

### statusCode

```ts
readonly statusCode: 500 = 500;
```

Defined in: [appkit/src/errors/initialization.ts:15](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/initialization.ts#L15)

HTTP status code suggestion (can be overridden)

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`statusCode`](Class.AppKitError.md#statuscode)

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Defined in: [appkit/src/errors/base.ts:68](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L68)

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

Defined in: [appkit/src/errors/base.ts:84](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L84)

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

Defined in: [appkit/src/errors/initialization.ts:46](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/initialization.ts#L46)

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

Defined in: [appkit/src/errors/initialization.ts:21](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/initialization.ts#L21)

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

Defined in: [appkit/src/errors/initialization.ts:36](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/initialization.ts#L36)

Create an initialization error for setup failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `component` | `string` |
| `cause?` | `Error` |

#### Returns

`InitializationError`
