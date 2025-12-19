# Variable: PieChart

```ts
const PieChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/appkit-ui/src/react/charts/pie/index.tsx:25](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/pie/index.tsx#L25)

Pie Chart component.
Supports both JSON and Arrow data formats with automatic format selection.

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`PieChartProps`](../type-aliases/PieChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<PieChart
  queryKey="market_share"
  parameters={{ category: "tech" }}
/>
```

```tsx
<PieChart
  queryKey="distribution"
  showLabels={true}
  labelPosition="inside"
/>
```
