# Variable: AreaChart

```ts
const AreaChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/appkit-ui/src/react/charts/area/index.tsx:25](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/area/index.tsx#L25)

Area Chart component.
Supports both JSON and Arrow data formats with automatic format selection.

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`AreaChartProps`](../type-aliases/AreaChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<AreaChart
  queryKey="traffic_data"
  parameters={{ period: "weekly" }}
/>
```

```tsx
<AreaChart
  queryKey="revenue_breakdown"
  parameters={{ groupBy: "product" }}
  stacked={true}
/>
```
