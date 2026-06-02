# Function: getApiErrorStatusCode()

```ts
function getApiErrorStatusCode(err: unknown): number | undefined;
```

Returns the HTTP status code for an SDK error from either SDK shape,
or `undefined` if `err` is not a recognized SDK error.

- Legacy SDK: reads `error.statusCode`.
- Modular SDK: reads `error.httpStatusCode` (returns `undefined` if it's
  the sentinel `-1`, which means the error wasn't HTTP-shaped).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `err` | `unknown` |

## Returns

`number` \| `undefined`
