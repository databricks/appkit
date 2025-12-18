# Variable: BarChart

```ts
const BarChart: {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/index.tsx:35](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/index.tsx#L35)

Bar Chart component.
Supports both JSON and Arrow data formats with automatic format selection.

## Type Declaration

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`BarChartProps`](../type-aliases/BarChartProps.md) |

## Returns

`Element`

### displayName

```ts
displayName: string;
```

## Examples

```tsx
<BarChart
  queryKey="top_contributors"
  parameters={{ limit: 10 }}
/>
```

```tsx
<BarChart
  queryKey="spend_data"
  parameters={{ startDate, endDate }}
  format="arrow"
/>
```

```tsx
<BarChart
  data={[
    { category: "A", value: 100 },
    { category: "B", value: 200 },
  ]}
/>
```
