# Function: useChartData()

```ts
function useChartData(options): UseChartDataResult;
```

Defined in: [packages/appkit-ui/src/react/hooks/use-chart-data.ts:104](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/use-chart-data.ts#L104)

Hook for fetching chart data in either JSON or Arrow format.
Automatically selects the best format based on query hints.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`UseChartDataOptions`](../interfaces/UseChartDataOptions.md) |

## Returns

[`UseChartDataResult`](../interfaces/UseChartDataResult.md)

## Example

```tsx
// Auto-select format
const { data, isArrow, loading } = useChartData({
  queryKey: "spend_data",
  parameters: { limit: 1000 }
});

// Force Arrow format
const { data } = useChartData({
  queryKey: "big_query",
  format: "arrow"
});
```
