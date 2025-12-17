# Function: PieChart()

```ts
function PieChart(props): Element;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/pie-chart.tsx:24](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/pie-chart.tsx#L24)

Production-ready pie chart with automatic data fetching and state management

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | [`PieChartProps`](../interfaces/PieChartProps.md) | Props for the PieChart component |

## Returns

`Element`

- The rendered chart component with error boundary

## Examples

```ts
// Simple usage
<PieChart queryKey="top_contributors" parameters={{ limit: 10 }} />
```

```ts
// With data transformation
<PieChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
```

```ts
// With full control mode
<PieChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 <Pie dataKey="value" fill="red" />
</BarChart>
```
