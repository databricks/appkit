import type { JSX } from "react";
import { createChart } from "../create-chart";
import type { HeatmapChartProps } from "../types";

/**
 * Heatmap Chart component for matrix-style data visualization.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Data should be in "long format" with three fields:
 * - xKey: X-axis category (columns)
 * - yAxisKey: Y-axis category (rows)
 * - yKey: The numeric value for each cell
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const HeatmapChart = createChart<HeatmapChartProps>(
  "heatmap",
  "HeatmapChart",
);

// Type-only definition for documentation generation (not used at runtime)
/**
 * Heatmap Chart component for matrix-style data visualization.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Data should be in "long format" with three fields:
 * - xKey: X-axis category (columns)
 * - yAxisKey: Y-axis category (rows)
 * - yKey: The numeric value for each cell
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export function HeatmapChartDoc(props: HeatmapChartProps): JSX.Element {
  return HeatmapChart(props);
}
