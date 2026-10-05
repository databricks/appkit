# Function: citedText()

```ts
function citedText(
   content: unknown, 
   field: ExtractField<unknown> | undefined, 
   metadata: ExtractMetadata | undefined): string[];
```

Returns the text each of a field's span citations points to, sliced from
the same `content` string sent to extract. Returns `[]` for bounding-box
citations, non-string content, or fields without citations.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `content` | `unknown` |
| `field` | [`ExtractField`](TypeAlias.ExtractField.md)\<`unknown`\> \| `undefined` |
| `metadata` | `ExtractMetadata` \| `undefined` |

## Returns

`string`[]
