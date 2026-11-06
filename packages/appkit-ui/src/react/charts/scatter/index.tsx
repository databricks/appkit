import { createChart } from "../create-chart";
import type { ScatterChartProps } from "../types";

/**
 * Scatter Chart component for correlation and distribution visualization.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const ScatterChart = createChart<ScatterChartProps>(
  "scatter",
  "ScatterChart",
);
