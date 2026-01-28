# Class: TunnelError

Error thrown when remote tunnel operations fail.
Use for tunnel connection issues, message parsing failures, etc.

## Example

```typescript
throw new TunnelError("No tunnel connection available");
throw new TunnelError("Failed to parse WebSocket message", { cause: parseError });
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new TunnelError(message: string, options?: {
  cause?: Error;
  context?: Record<string, unknown>;
}): TunnelError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `context?`: `Record`\<`string`, `unknown`\>; \} |
| `options.cause?` | `Error` |
| `options.context?` | `Record`\<`string`, `unknown`\> |

#### Returns

`TunnelError`

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
readonly code: "TUNNEL_ERROR" = "TUNNEL_ERROR";
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
readonly statusCode: 502 = 502;
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

### fetchFailed()

```ts
static fetchFailed(path: string, cause?: Error): TunnelError;
```

Create a tunnel error for asset fetch failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |
| `cause?` | `Error` |

#### Returns

`TunnelError`

***

### getterNotRegistered()

```ts
static getterNotRegistered(): TunnelError;
```

Create a tunnel error for missing tunnel getter

#### Returns

`TunnelError`

***

### noConnection()

```ts
static noConnection(): TunnelError;
```

Create a tunnel error for no available connection

#### Returns

`TunnelError`

***

### parseError()

```ts
static parseError(messageType: string, cause?: Error): TunnelError;
```

Create a tunnel error for message parsing failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `messageType` | `string` |
| `cause?` | `Error` |

#### Returns

`TunnelError`
