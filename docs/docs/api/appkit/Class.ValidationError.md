# Class: ValidationError

Error thrown when input validation fails.
Use for invalid parameters, missing required fields, or type mismatches.

## Example

```typescript
throw new ValidationError("Statement is required", { context: { field: "statement" } });
throw new ValidationError("maxPoolSize must be at least 1", { context: { value: config.maxPoolSize } });
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new ValidationError(message: string, options?: {
  cause?: Error;
  context?: Record<string, unknown>;
}): ValidationError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `context?`: `Record`\<`string`, `unknown`\>; \} |
| `options.cause?` | `Error` |
| `options.context?` | `Record`\<`string`, `unknown`\> |

#### Returns

`ValidationError`

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
readonly code: "VALIDATION_ERROR" = "VALIDATION_ERROR";
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
readonly isRetryable: false = false;
```

Whether this error type is generally safe to retry

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`isRetryable`](Class.AppKitError.md#isretryable)

***

### statusCode

```ts
readonly statusCode: 400 = 400;
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

### invalidValue()

```ts
static invalidValue(
   fieldName: string, 
   value: unknown, 
   expected?: string): ValidationError;
```

Create a validation error for an invalid field value.
Note: The actual value is not stored in context for security reasons.
Only the value's type is recorded.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fieldName` | `string` |
| `value` | `unknown` |
| `expected?` | `string` |

#### Returns

`ValidationError`

***

### missingEnvVars()

```ts
static missingEnvVars(vars: string[]): ValidationError;
```

Create a validation error for missing environment variables

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `vars` | `string`[] |

#### Returns

`ValidationError`

***

### missingField()

```ts
static missingField(fieldName: string): ValidationError;
```

Create a validation error for a missing required field

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fieldName` | `string` |

#### Returns

`ValidationError`
