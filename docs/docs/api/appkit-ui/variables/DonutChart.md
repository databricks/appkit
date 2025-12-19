# Variable: DonutChart

```ts
const DonutChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/appkit-ui/src/react/charts/pie/index.tsx:47](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/pie/index.tsx#L47)

Donut Chart component (Pie chart with inner radius).
Supports both JSON and Arrow data formats with automatic format selection.

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`DonutChartProps`](../type-aliases/DonutChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<DonutChart
  queryKey="budget_allocation"
  parameters={{ year: 2024 }}
/>
```

```tsx
<DonutChart
  queryKey="progress"
  innerRadius={60}
/>
```
