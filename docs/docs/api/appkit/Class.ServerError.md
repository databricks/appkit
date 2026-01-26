# Class: ServerError

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

### autoStartConflict()

```ts
static autoStartConflict(operation: string): ServerError;
```

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
