# Class: ServerError

Error thrown when server lifecycle operations fail.
Use for server start/stop issues, configuration conflicts, etc.

## Example

```typescript
throw new ServerError("Server not started");
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new ServerError(message: string, options?: {
  cause?: Error;
  clientMessage?: string;
  context?: Record<string, unknown>;
}): ServerError;
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

`ServerError`

#### Inherited from

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
readonly code: "SERVER_ERROR" = "SERVER_ERROR";
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

#### Inherited from

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

### clientDirectoryNotFound()

```ts
static clientDirectoryNotFound(searchedPaths: string[]): ServerError;
```

Create a server error for missing client directory

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `searchedPaths` | `string`[] |

#### Returns

`ServerError`

***

### notStarted()

```ts
static notStarted(): ServerError;
```

Create a server error for server not started

#### Returns

`ServerError`

***

### viteNotInitialized()

```ts
static viteNotInitialized(): ServerError;
```

Create a server error for Vite dev server not initialized

#### Returns

`ServerError`
