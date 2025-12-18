# Function: normalizeHeatmapData()

```ts
function normalizeHeatmapData(
   data, 
   xKey?, 
   yAxisKey?, 
   valueKey?): NormalizedHeatmapData;
```

Defined in: [packages/app-kit-ui/src/react/charts/normalize.ts:326](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/normalize.ts#L326)

Normalizes data specifically for heatmap charts.
Expects data in format: `{ xKey: string, yAxisKey: string, valueKey: number }`

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `data` | [`ChartData`](../type-aliases/ChartData.md) | Raw data (Arrow Table or JSON array) |
| `xKey?` | `string` | Field key for X-axis (columns) |
| `yAxisKey?` | `string` | Field key for Y-axis (rows) |
| `valueKey?` | `string` \| `string`[] | Field key for the cell values |

## Returns

[`NormalizedHeatmapData`](../interfaces/NormalizedHeatmapData.md)
