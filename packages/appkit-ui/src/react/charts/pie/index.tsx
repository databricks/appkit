import { createChart } from "../create-chart";
import type { DonutChartProps, PieChartProps } from "../types";

/**
 * Pie Chart component for proportional data visualization.
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const PieChart = createChart<PieChartProps>("pie", "PieChart");

/**
 * Donut Chart component (Pie chart with inner radius).
 *
 * **Important:** This component uses Apache ECharts architecture. Configure it via props, not by passing child components.
 *
 * **Best Practice:** Use the built-in data fetching by passing `queryKey` and `parameters` props instead of pre-fetching data with `useAnalyticsQuery`.
 *
 * Supports both query mode (queryKey + parameters) and data mode (static data).
 */
export const DonutChart = createChart<DonutChartProps>("donut", "DonutChart");
