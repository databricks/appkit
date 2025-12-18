# Function: createChart()

```ts
function createChart<TProps>(chartType, displayName): {
(props): Element;
  displayName: string;
};
```

Defined in: [packages/app-kit-ui/src/react/charts/create-chart.tsx:19](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/create-chart.tsx#L19)

Factory function to create chart components.
Eliminates boilerplate by generating components with the same pattern.

## Type Parameters

| Type Parameter |
| ------ |
| `TProps` *extends* [`UnifiedChartProps`](../type-aliases/UnifiedChartProps.md) |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `chartType` | [`ChartType`](../type-aliases/ChartType.md) | The ECharts chart type |
| `displayName` | `string` | Component display name for React DevTools |

## Returns

A typed chart component

```ts
(props): Element;
```

### Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | `TProps` |

### Returns

`Element`

### displayName

```ts
displayName: string;
```

## Example

```tsx
export const BarChart = createChart<BarChartProps>("bar", "BarChart");
export const LineChart = createChart<LineChartProps>("line", "LineChart");
```
