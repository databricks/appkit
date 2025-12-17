# Function: useChartData()

```ts
function useChartData<TRaw, TProcessed>(options): UseChartDataResult<TProcessed>;
```

Defined in: [packages/app-kit-ui/src/react/hooks/use-chart-data.ts:42](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-chart-data.ts#L42)

Hook for fetching, processing and validating chart data with automatic state management

## Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TRaw` | `any` | The raw data type return by the analytics query |
| `TProcessed` | `any` | The processed data type |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | `UseChartDataOptions`\<`TRaw`, `TProcessed`\> | Configuration options for data fetching and processing |

## Returns

`UseChartDataResult`\<`TProcessed`\>

Object containing the processed data, loading state, error state and empty state
