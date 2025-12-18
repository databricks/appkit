# Variable: HeatmapChart

```ts
const HeatmapChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/app-kit-ui/src/react/charts/heatmap/index.tsx:34](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/heatmap/index.tsx#L34)

Heatmap Chart component.
Supports both JSON and Arrow data formats with automatic format selection.

Data should be in "long format" with three fields:
- xKey: X-axis category (columns)
- yAxisKey: Y-axis category (rows)
- yKey: The numeric value for each cell

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`HeatmapChartProps`](../type-aliases/HeatmapChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<HeatmapChart
  queryKey="activity_matrix"
  xKey="day"
  yAxisKey="hour"
  yKey="count"
/>
```

```tsx
<HeatmapChart
  queryKey="correlation_matrix"
  min={-1}
  max={1}
  showLabels={true}
  colorPalette="diverging"
/>
```
