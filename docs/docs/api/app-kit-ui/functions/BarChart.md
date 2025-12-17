# Function: BarChart()

```ts
function BarChart(props): Element;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/bar-chart.tsx:65](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/bar-chart.tsx#L65)

Bar chart component with automatic query execution and data visualization.

Integrates with the analytics plugin to fetch and display data as a bar chart.
Supports automatic field detection, custom transformations, loading states,
and error handling out of the box.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | [`BarChartProps`](../interfaces/BarChartProps.md) | Bar chart configuration |

## Returns

`Element`

Rendered bar chart with loading and error states

## Examples

Basic bar chart
```typescript
import { BarChart } from '@databricks/app-kit-ui';

function TopContributors() {
  return (
    <BarChart
      queryKey="top_contributors"
      parameters={{ limit: 10 }}
    />
  );
}
```

Horizontal bar chart with custom styling
```typescript
import { BarChart } from '@databricks/app-kit-ui';

function SalesChart() {
  return (
    <BarChart
      queryKey="sales_by_region"
      orientation="horizontal"
      height="400px"
      chartConfig={{
        sales: { label: 'Sales', color: '#8884d8' }
      }}
    />
  );
}
```
