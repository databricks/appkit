# Variable: ScatterChart

```ts
const ScatterChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/app-kit-ui/src/react/charts/scatter/index.tsx:24](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/scatter/index.tsx#L24)

Scatter Chart component.
Supports both JSON and Arrow data formats with automatic format selection.

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`ScatterChartProps`](../type-aliases/ScatterChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<ScatterChart
  queryKey="correlation_data"
  parameters={{ metrics: ["revenue", "growth"] }}
/>
```

```tsx
<ScatterChart
  queryKey="data_points"
  symbolSize={12}
/>
```
