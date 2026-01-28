import type { JSX } from "react";
import { createChart } from "../create-chart";
import type { RadarChartProps } from "../types";

/**
 * Radar Chart component for multi-dimensional data comparison.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const RadarChart = createChart<RadarChartProps>("radar", "RadarChart");

// Type-only definition for documentation generation (not used at runtime)
/**
 * Radar Chart component for multi-dimensional data comparison.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export function RadarChartDoc(props: RadarChartProps): JSX.Element {
  return RadarChart(props);
}
