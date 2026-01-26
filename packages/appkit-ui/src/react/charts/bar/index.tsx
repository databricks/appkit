import type { JSX } from "react";
import { createChart } from "../create-chart";
import type { BarChartProps } from "../types";

/**
 * Bar Chart component for categorical comparisons.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const BarChart = createChart<BarChartProps>("bar", "BarChart");

// Type-only definition for documentation generation (not used at runtime)
/**
 * Bar Chart component for categorical comparisons.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export function BarChartDoc(props: BarChartProps): JSX.Element {
  return BarChart(props);
}
