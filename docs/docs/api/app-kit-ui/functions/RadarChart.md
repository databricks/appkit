# Function: RadarChart()

```ts
function RadarChart(props): Element;
```

Defined in: [packages/app-kit-ui/src/react/charts/radar/radar-chart.tsx:29](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/radar/radar-chart.tsx#L29)

Production-ready radar chart with automatic data fetching and state management

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | [`RadarChartProps`](../interfaces/RadarChartProps.md) | Props for the RadarChart component |

## Returns

`Element`

- The rendered chart component with error boundary

## Examples

```ts
// Simple usage
<RadarChart queryKey="top_contributors" parameters={{ limit: 10 }} />
```

```ts
// With custom data transformation
<RadarChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
```

```ts
// With full control mode
<RadarChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 <Radar dataKey="value" fill="red" />
</RadarChart>
```
