# Variable: LineChart

```ts
const LineChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/appkit-ui/src/react/charts/line/index.tsx:26](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/line/index.tsx#L26)

Line Chart component.
Supports both JSON and Arrow data formats with automatic format selection.

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`LineChartProps`](../type-aliases/LineChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<LineChart
  queryKey="revenue_over_time"
  parameters={{ period: "monthly" }}
/>
```

```tsx
<LineChart
  queryKey="trends"
  parameters={{ metric: "users" }}
  smooth={false}
  showSymbol={true}
/>
```
