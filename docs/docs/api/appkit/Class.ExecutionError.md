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
  clientMessage?: string;
  context?: Record<string, unknown>;
  errorCode?: string;
}): ExecutionError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `clientMessage?`: `string`; `context?`: `Record`\<`string`, `unknown`\>; `errorCode?`: `string`; \} |
| `options.cause?` | `Error` |
| `options.clientMessage?` | `string` |
| `options.context?` | `Record`\<`string`, `unknown`\> |
| `options.errorCode?` | `string` |

#### Returns

`ExecutionError`

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`constructor`](Class.AppKitError.md#constructor)

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

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`_clientMessage`](Class.AppKitError.md#_clientmessage)

***

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
readonly code: "EXECUTION_ERROR" = "EXECUTION_ERROR";
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

### errorCode?

```ts
readonly optional errorCode: string;
```

Structured error code from the upstream source (typically the warehouse's
`error_code` for statement-level failures, or the SDK's `ApiError.errorCode`
for HTTP failures). Preserved through wrapping so callers can branch on a
stable identifier without substring-matching the message.

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

## Accessors

### clientMessage

#### Get Signature

```ts
get clientMessage(): string;
```

Execution errors default to a generic message — the raw warehouse /
SDK text in `.message` often includes statement fragments, internal
paths, and correlation IDs. UI code should branch on `errorCode`
(`RESULT_TOO_LARGE_FOR_JSON_FALLBACK`, `NOT_IMPLEMENTED`, etc.) and not on
the human string.

##### Returns

`string`

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`clientMessage`](Class.AppKitError.md#clientmessage)

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

Create an execution error for canceled operation

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
static statementFailed(
   errorMessage?: string, 
   errorCode?: string, 
   clientMessage?: string): ExecutionError;
```

Create an execution error for statement failure.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `errorMessage?` | `string` | Human-readable error from the warehouse / SDK. Goes into `.message` for server logs only — *never* echoed to the client. Pass `clientMessage` explicitly if a sanitized text should reach the UI. |
| `errorCode?` | `string` | Structured code (e.g. "INVALID_PARAMETER_VALUE") to preserve through wrapping. Optional. Forwarded on SSE error payloads so UI can branch on it instead of substring-matching `error`. |
| `clientMessage?` | `string` | Optional client-safe replacement for `.message`. Defaults to "Query execution failed" via the `clientMessage` getter. Set this only when the upstream text is known-safe. |

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
