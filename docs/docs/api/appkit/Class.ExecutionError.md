# Class: ExecutionError

Defined in: appkit/src/errors/execution.ts:13

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
  context?: Record<string, unknown>;
}): ExecutionError;
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

`ExecutionError`

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
readonly code: "EXECUTION_ERROR" = "EXECUTION_ERROR";
```

Defined in: appkit/src/errors/execution.ts:14

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

Defined in: appkit/src/errors/execution.ts:16

Whether this error type is generally safe to retry

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`isRetryable`](Class.AppKitError.md#isretryable)

***

### statusCode

```ts
readonly statusCode: 500 = 500;
```

Defined in: appkit/src/errors/execution.ts:15

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

### canceled()

```ts
static canceled(): ExecutionError;
```

Defined in: appkit/src/errors/execution.ts:31

Create an execution error for canceled operation

#### Returns

`ExecutionError`

***

### missingData()

```ts
static missingData(dataType: string): ExecutionError;
```

Defined in: appkit/src/errors/execution.ts:56

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

Defined in: appkit/src/errors/execution.ts:38

Create an execution error for closed/expired results

#### Returns

`ExecutionError`

***

### statementFailed()

```ts
static statementFailed(errorMessage?: string): ExecutionError;
```

Defined in: appkit/src/errors/execution.ts:21

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

Defined in: appkit/src/errors/execution.ts:47

Create an execution error for unknown state

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `state` | `string` |

#### Returns

`ExecutionError`
