# Function: normalizeChartData()

```ts
function normalizeChartData(
   data, 
   xKey?, 
   yKey?, 
   orientation?): NormalizedChartData;
```

Defined in: [packages/app-kit-ui/src/react/charts/normalize.ts:216](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/normalize.ts#L216)

Normalizes chart data from either Arrow or JSON format.
Converts BigInt and Date values to chart-compatible types.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | [`ChartData`](../type-aliases/ChartData.md) |
| `xKey?` | `string` |
| `yKey?` | `string` \| `string`[] |
| `orientation?` | [`Orientation`](../type-aliases/Orientation.md) |

## Returns

[`NormalizedChartData`](../interfaces/NormalizedChartData.md)
