# Function: LineChart()

```ts
function LineChart(props): Element;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/line-chart.tsx:30](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/line-chart.tsx#L30)

Production-ready line chart with automatic data fetching and state management

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | [`LineChartProps`](../interfaces/LineChartProps.md) | Props for the LineChart component |

## Returns

`Element`

- The rendered chart component with error boundary

## Examples

```ts
// Simple usage
<LineChart queryKey="top_contributors" parameters={{ limit: 10 }} />
```

```ts
// With data transformation
<LineChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
```

```ts
// With full control mode
<LineChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 <Line dataKey="value" fill="red" />
</LineChart>
```
