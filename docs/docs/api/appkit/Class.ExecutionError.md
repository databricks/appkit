# Class: ExecutionError

Error thrown when an operation execution fails.
Use for statement failures, canceled operations, or unexpected states.

## Example

```typescript
throw new ExecutionError("Statement failed: syntax error");
throw new ExecutionError("Statement was canceled");
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new ExecutionError(message: string, options?: {
  cause?: Error;
  code?: string;
  context?: Record<string, unknown>;
}): ExecutionError;
```

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `message` | `string` | - |
| `options?` | \{ `cause?`: `Error`; `code?`: `string`; `context?`: `Record`\<`string`, `unknown`\>; \} | - |
| `options.cause?` | `Error` | - |
| `options.code?` | `string` | Stable machine-readable code (defaults to `"EXECUTION_ERROR"`). |
| `options.context?` | `Record`\<`string`, `unknown`\> | - |

#### Returns

`ExecutionError`

#### Overrides

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
readonly code: string;
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
readonly statusCode: 500 = 500;
```

HTTP status code suggestion (can be overridden)

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`statusCode`](Class.AppKitError.md#statuscode)

***

### CANCELED\_CODE

```ts
readonly static CANCELED_CODE: "EXECUTION_CANCELED" = "EXECUTION_CANCELED";
```

Stable code carried by errors created via [ExecutionError.canceled](#canceled).
Lets consumers detect cancellation programmatically without inspecting
the message (which may be masked in production).

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

### canceled()

```ts
static canceled(): ExecutionError;
```

Create an execution error for canceled operation.
Carries the [ExecutionError.CANCELED\_CODE](#canceled_code) code so cancellation
stays distinguishable even when the message is masked in production.

#### Returns

`ExecutionError`

***

### missingData()

```ts
static missingData(dataType: string): ExecutionError;
```

Create an execution error for missing data

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `dataType` | `string` |

#### Returns

`ExecutionError`

***

### resultsClosed()

```ts
static resultsClosed(): ExecutionError;
```

Create an execution error for closed/expired results

#### Returns

`ExecutionError`

***

### statementFailed()

```ts
static statementFailed(errorMessage?: string): ExecutionError;
```

Create an execution error for statement failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `errorMessage?` | `string` |

#### Returns

`ExecutionError`

***

### unknownState()

```ts
static unknownState(state: string): ExecutionError;
```

Create an execution error for unknown state

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `state` | `string` |

#### Returns

`ExecutionError`
