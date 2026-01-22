import type React from "react";
import { createChart } from "../create-chart";
import type { LineChartProps } from "../types";

/**
 * Line Chart component for time-series and trend visualization.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 * 
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const LineChart = createChart<LineChartProps>("line", "LineChart");

// Type-only definition for documentation generation (not used at runtime)
/**
 * Line Chart component for time-series and trend visualization.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 * 
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export function LineChartDoc(props: LineChartProps): JSX.Element {
  return LineChart(props);
}
