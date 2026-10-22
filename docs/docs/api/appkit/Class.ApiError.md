# Class: ApiError

## Extends

- `Error`

## Constructors

### Constructor

```ts
new ApiError(
   message: string, 
   errorCode: string, 
   statusCode: number, 
   response?: unknown, 
   details?: unknown[]): ApiError;
```

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `message` | `string` | `undefined` |
| `errorCode` | `string` | `undefined` |
| `statusCode` | `number` | `undefined` |
| `response?` | `unknown` | `undefined` |
| `details?` | `unknown`[] | `[]` |

#### Returns

`ApiError`

#### Overrides

```ts
Error.constructor
```

## Properties

### details

```ts
readonly details: unknown[] = [];
```

***

### errorCode

```ts
readonly errorCode: string;
```

***

### response?

```ts
readonly optional response: unknown;
```

***

### statusCode

```ts
readonly statusCode: number;
```

## Methods

### isRetryable()

```ts
isRetryable(): boolean;
```

Like the legacy SDK: only 429 is retryable by status alone.

#### Returns

`boolean`

***

### \[hasInstance\]()

```ts
static hasInstance: boolean;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

#### Returns

`boolean`
