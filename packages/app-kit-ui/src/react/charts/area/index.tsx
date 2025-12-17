import { createChart } from "../create-chart";
import type { AreaChartProps } from "../types";

/**
 * Area Chart component.
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * @example Simple usage
 * ```tsx
 * <AreaChart
 *   queryKey="traffic_data"
 *   parameters={{ period: "weekly" }}
 * />
 * ```
 *
 * @example Stacked area chart
 * ```tsx
 * <AreaChart
 *   queryKey="revenue_breakdown"
 *   parameters={{ groupBy: "product" }}
 *   stacked={true}
 * />
 * ```
 */
export const AreaChart = createChart<AreaChartProps>("area", "AreaChart");
