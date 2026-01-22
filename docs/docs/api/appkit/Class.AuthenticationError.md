# Class: AuthenticationError

Defined in: [appkit/src/errors/authentication.ts:13](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L13)

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
  context?: Record<string, unknown>;
}): AuthenticationError;
```

Defined in: [appkit/src/errors/base.ts:49](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L49)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `cause?`: `Error`; `context?`: `Record`\<`string`, `unknown`\>; \} |
| `options.cause?` | `Error` |
| `options.context?` | `Record`\<`string`, `unknown`\> |

#### Returns

`AuthenticationError`

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`constructor`](Class.AppKitError.md#constructor)

## Properties

### cause?

```ts
readonly optional cause: Error;
```

Defined in: [appkit/src/errors/base.ts:44](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L44)

Optional cause of the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`cause`](Class.AppKitError.md#cause)

***

### code

```ts
readonly code: "AUTHENTICATION_ERROR" = "AUTHENTICATION_ERROR";
```

Defined in: [appkit/src/errors/authentication.ts:14](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L14)

Error code for programmatic error handling

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`code`](Class.AppKitError.md#code)

***

### context?

```ts
readonly optional context: Record<string, unknown>;
```

Defined in: [appkit/src/errors/base.ts:47](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L47)

Additional context for the error

#### Inherited from

[`AppKitError`](Class.AppKitError.md).[`context`](Class.AppKitError.md#context)

***

### isRetryable

```ts
readonly isRetryable: false = false;
```

Defined in: [appkit/src/errors/authentication.ts:16](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L16)

Whether this error type is generally safe to retry

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`isRetryable`](Class.AppKitError.md#isretryable)

***

### statusCode

```ts
readonly statusCode: 401 = 401;
```

Defined in: [appkit/src/errors/authentication.ts:15](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L15)

HTTP status code suggestion (can be overridden)

#### Overrides

[`AppKitError`](Class.AppKitError.md).[`statusCode`](Class.AppKitError.md#statuscode)

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Defined in: [appkit/src/errors/base.ts:68](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L68)

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

Defined in: [appkit/src/errors/base.ts:84](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/base.ts#L84)

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

Defined in: [appkit/src/errors/authentication.ts:40](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L40)

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

Defined in: [appkit/src/errors/authentication.ts:21](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L21)

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

Defined in: [appkit/src/errors/authentication.ts:30](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L30)

Create an authentication error for missing user identity

#### Returns

`AuthenticationError`

***

### userLookupFailed()

```ts
static userLookupFailed(cause?: Error): AuthenticationError;
```

Defined in: [appkit/src/errors/authentication.ts:53](https://github.com/databricks/appkit/blob/main/packages/appkit/src/errors/authentication.ts#L53)

Create an authentication error for failed user lookup

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cause?` | `Error` |

#### Returns

`AuthenticationError`
