# Function: useAnalyticsQuery()

```ts
function useAnalyticsQuery<T, K, F>(
   queryKey, 
   parameters?, 
options?): UseAnalyticsQueryResult<InferResultByFormat<T, K, F>>;
```

Defined in: [packages/appkit-ui/src/react/hooks/use-analytics-query.ts:50](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/use-analytics-query.ts#L50)

Subscribe to an analytics query over SSE and returns its latest result.
Integration hook between client and analytics plugin.

The return type is automatically inferred based on the format:
- `format: "JSON"` (default): Returns typed array from QueryRegistry
- `format: "ARROW"`: Returns TypedArrowTable with row type preserved

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` | `unknown` |
| `K` *extends* `string` | `string` |
| `F` *extends* [`AnalyticsFormat`](../type-aliases/AnalyticsFormat.md) | `"JSON"` |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `queryKey` | `K` | Analytics query identifier |
| `parameters?` | `InferParams`\<`K`\> \| `null` | Query parameters (type-safe based on QueryRegistry) |
| `options?` | [`UseAnalyticsQueryOptions`](../interfaces/UseAnalyticsQueryOptions.md)\<`F`\> | Analytics query settings including format |

## Returns

[`UseAnalyticsQueryResult`](../interfaces/UseAnalyticsQueryResult.md)\<[`InferResultByFormat`](../type-aliases/InferResultByFormat.md)\<`T`, `K`, `F`\>\>

Query result state with format-appropriate data type

## Examples

```typescript
const { data } = useAnalyticsQuery("spend_data", params);
// data: Array<{ group_key: string; cost_usd: number; ... }> | null
```

```typescript
const { data } = useAnalyticsQuery("spend_data", params, { format: "ARROW" });
// data: TypedArrowTable<{ group_key: string; cost_usd: number; ... }> | null
```
