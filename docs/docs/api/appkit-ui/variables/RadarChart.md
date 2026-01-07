# Variable: RadarChart

```ts
const RadarChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/appkit-ui/src/react/charts/radar/index.tsx:24](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/radar/index.tsx#L24)

Radar Chart component.
Supports both JSON and Arrow data formats with automatic format selection.

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`RadarChartProps`](../type-aliases/RadarChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<RadarChart
  queryKey="skills_assessment"
  parameters={{ userId: "123" }}
/>
```

```tsx
<RadarChart
  queryKey="performance_metrics"
  showArea={true}
/>
```
