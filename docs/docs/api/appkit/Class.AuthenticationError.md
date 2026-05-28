# Class: AuthenticationError

Error thrown when authentication fails.
Use for missing tokens, invalid credentials, or authorization failures.

## Example

```typescript
throw new AuthenticationError("User token is required");
throw new AuthenticationError("Failed to generate credentials", { cause: originalError });
```

## Extends

- [`AppKitError`](Class.AppKitError.md)

## Constructors

### Constructor

```ts
new AuthenticationError(message: string, options?: {
  cause?: Error;
  clientMessage?: string;
  context?: Record<string, unknown>;
}): AuthenticationError;
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

`AuthenticationError`

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
readonly code: "AUTHENTICATION_ERROR" = "AUTHENTICATION_ERROR";
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
readonly statusCode: 401 = 401;
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

### credentialsFailed()

```ts
static credentialsFailed(instance: string, cause?: Error): AuthenticationError;
```

Create an authentication error for credential generation failure

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `instance` | `string` |
| `cause?` | `Error` |

#### Returns

`AuthenticationError`

***

### missingToken()

```ts
static missingToken(tokenType: string): AuthenticationError;
```

Create an authentication error for missing token

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `tokenType` | `string` | `"access token"` |

#### Returns

`AuthenticationError`

***

### missingUserId()

```ts
static missingUserId(): AuthenticationError;
```

Create an authentication error for missing user identity

#### Returns

`AuthenticationError`

***

### userLookupFailed()

```ts
static userLookupFailed(cause?: Error): AuthenticationError;
```

Create an authentication error for failed user lookup

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cause?` | `Error` |

#### Returns

`AuthenticationError`
