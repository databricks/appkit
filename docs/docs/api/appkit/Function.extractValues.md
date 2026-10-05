# Function: extractValues()

```ts
function extractValues<S>(result: ExtractResponse<unknown>, schema: S): ExtractValues<S> | undefined;
```

Removes the `{ value }` wrappers from an extract response, guided by the
schema that produced it. Missing leaves become `null`, missing arrays `[]`.
Returns `undefined` when the response has no `response` field.

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `ExtractSchema` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `result` | [`ExtractResponse`](Interface.ExtractResponse.md)\<`unknown`\> |
| `schema` | `S` |

## Returns

`ExtractValues`\<`S`\> \| `undefined`
