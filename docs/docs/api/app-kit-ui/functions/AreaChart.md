# Function: AreaChart()

```ts
function AreaChart(props): Element;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/area-chart.tsx:30](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/area-chart.tsx#L30)

Production-ready area chart with automatic data fetching and state management

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | [`AreaChartProps`](../interfaces/AreaChartProps.md) | Props for the AreaChart component |

## Returns

`Element`

- The rendered chart component with error boundary

## Examples

```ts
// Simple usage
<AreaChart queryKey="top_contributors" parameters={{ limit: 10 }} />
```

```ts
// With custom data transformation
<AreaChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
```

```ts
// With full control mode
<AreaChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 <Area dataKey="value" fill="red" />
</AreaChart>
```
