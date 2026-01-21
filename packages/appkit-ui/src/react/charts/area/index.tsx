import { createChart } from "../create-chart";
import type { AreaChartProps } from "../types";

/**
 * Area Chart component for trend visualization with filled areas.
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper.
 *
 * @example Stacked area chart
 * ```tsx
 * <AreaChart
 *   queryKey="revenue_breakdown"
 *   parameters={{}}
 *   xKey="date"
 *   yKey={["product_a", "product_b", "product_c"]}
 *   stacked
 *   showLegend
 * />
 * ```
 *
 * @example Query mode with format selection
 * ```tsx
 * <AreaChart
 *   queryKey="traffic_data"
 *   parameters={{ period: "weekly" }}
 *   format="arrow"  // Force Arrow for large datasets
 *   xKey="week"
 *   yKey="visitors"
 * />
 * ```
 */
export const AreaChart = createChart<AreaChartProps>("area", "AreaChart");
