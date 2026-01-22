# Class: ServerError

Defined in: appkit/src/errors/server.ts:13

Error thrown when server lifecycle operations fail.
Use for server start/stop issues, configuration conflicts, etc.

## Example

```typescript
throw new ServerError("Cannot get server when autoStart is true");
throw new ServerError("Server not started");
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new ServerError(message: string, options?: {
  cause?: Error;
  context?: Record<string, unknown>;
}): ServerError;
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

`ServerError`

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
readonly code: "SERVER_ERROR" = "SERVER_ERROR";
```

Defined in: appkit/src/errors/server.ts:14

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

Defined in: appkit/src/errors/server.ts:16

Whether this error type is generally safe to retry

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`isRetryable`](Class.AppKitError.md#isretryable)

***

### statusCode

```ts
readonly statusCode: 500 = 500;
```

Defined in: appkit/src/errors/server.ts:15

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

### autoStartConflict()

```ts
static autoStartConflict(operation: string): ServerError;
```

Defined in: appkit/src/errors/server.ts:21

Create a server error for autoStart conflict

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |

#### Returns

`ServerError`

***

### clientDirectoryNotFound()

```ts
static clientDirectoryNotFound(searchedPaths: string[]): ServerError;
```

Defined in: appkit/src/errors/server.ts:46

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

Defined in: appkit/src/errors/server.ts:30

Create a server error for server not started

#### Returns

`ServerError`

***

### viteNotInitialized()

```ts
static viteNotInitialized(): ServerError;
```

Defined in: appkit/src/errors/server.ts:39

Create a server error for Vite dev server not initialized

#### Returns

`ServerError`
