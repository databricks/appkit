# Class: ConfigurationError

Defined in: appkit/src/errors/configuration.ts:13

Error thrown when configuration is missing or invalid.
Use for missing environment variables, invalid settings, or setup issues.

## Example

```typescript
throw new ConfigurationError("DATABRICKS_HOST environment variable is required");
throw new ConfigurationError("Warehouse ID not found", { context: { env: "production" } });
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new ConfigurationError(message: string, options?: {
  cause?: Error;
  context?: Record<string, unknown>;
}): ConfigurationError;
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

`ConfigurationError`

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`constructor`](Class.AppKitError.md#constructor)

## Properties

### cause?

```ts
readonly optional cause: Error;
```

Defined in: appkit/src/errors/base.ts:44

Optional cause of the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`cause`](Class.AppKitError.md#cause)

***

### code

```ts
readonly code: "CONFIGURATION_ERROR" = "CONFIGURATION_ERROR";
```

Defined in: appkit/src/errors/configuration.ts:14

Error code for programmatic error handling

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`code`](Class.AppKitError.md#code)

***

### context?

```ts
readonly optional context: Record<string, unknown>;
```

Defined in: appkit/src/errors/base.ts:47

Additional context for the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`context`](Class.AppKitError.md#context)

***

### isRetryable

```ts
readonly isRetryable: false = false;
```

Defined in: appkit/src/errors/configuration.ts:16

Whether this error type is generally safe to retry

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`isRetryable`](Class.AppKitError.md#isretryable)

***

### statusCode

```ts
readonly statusCode: 500 = 500;
```

Defined in: appkit/src/errors/configuration.ts:15

HTTP status code suggestion (can be overridden)

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`statusCode`](Class.AppKitError.md#statuscode)

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

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`toJSON`](Class.AppKitError.md#tojson)

***

### toString()

```ts
toString(): string;
```

Defined in: appkit/src/errors/base.ts:84

Create a human-readable string representation

#### Returns

`string`

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`toString`](Class.AppKitError.md#tostring)

***

### invalidConnection()

```ts
static invalidConnection(service: string, details?: string): ConfigurationError;
```

Defined in: appkit/src/errors/configuration.ts:41

Create a configuration error for invalid connection config

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `service` | `string` |
| `details?` | `string` |

#### Returns

`ConfigurationError`

***

### missingConnectionParam()

```ts
static missingConnectionParam(param: string): ConfigurationError;
```

Defined in: appkit/src/errors/configuration.ts:54

Create a configuration error for missing connection string parameter

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `param` | `string` |

#### Returns

`ConfigurationError`

***

### missingEnvVar()

```ts
static missingEnvVar(varName: string): ConfigurationError;
```

Defined in: appkit/src/errors/configuration.ts:21

Create a configuration error for missing environment variable

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `varName` | `string` |

#### Returns

`ConfigurationError`

***

### resourceNotFound()

```ts
static resourceNotFound(resource: string, hint?: string): ConfigurationError;
```

Defined in: appkit/src/errors/configuration.ts:31

Create a configuration error for missing resource

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `resource` | `string` |
| `hint?` | `string` |

#### Returns

`ConfigurationError`
