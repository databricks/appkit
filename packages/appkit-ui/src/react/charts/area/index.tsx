import type React from "react";
import { createChart } from "../create-chart";
import type { AreaChartProps } from "../types";

/**
 * Area Chart component for trend visualization with filled areas.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 * 
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const AreaChart = createChart<AreaChartProps>("area", "AreaChart");

// Type-only definition for documentation generation (not used at runtime)
/**
 * Area Chart component for trend visualization with filled areas.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 * 
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export function AreaChartDoc(props: AreaChartProps): JSX.Element {
  return AreaChart(props);
}
