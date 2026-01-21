import { createChart } from "../create-chart";
import type { LineChartProps } from "../types";

/**
 * Line Chart component for time-series and trend visualization.
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper. Do not use Recharts components as children.
 * ⚠️ ANTI-PATTERN: Don't fetch with useAnalyticsQuery then pass to chart - let the chart fetch.
 *
 * @example Query mode (recommended for Databricks analytics)
 * ```tsx
 * import { LineChart } from "@databricks/appkit-ui/react";
 * import { sql } from "@databricks/appkit-ui/js";
 * import { useMemo } from "react";
 *
 * export function SpendChart() {
 *   const params = useMemo(
 *     () => ({
 *       startDate: sql.date("2024-01-01"),
 *       endDate: sql.date("2024-12-31"),
 *       aggregationLevel: sql.string("day"),
 *     }),
 *     [],
 *   );
 *
 *   return (
 *     <LineChart
 *       queryKey="spend_data"
 *       parameters={params}
 *       format="auto"      // "auto" | "json" | "arrow"
 *       xKey="period"
 *       yKey="cost_usd"
 *       smooth
 *       showSymbol={false}
 *     />
 *   );
 * }
 * ```
 *
 * @example Data mode (for static/client-side data)
 * ```tsx
 * <LineChart
 *   data={[
 *     { month: "Jan", sales: 100 },
 *     { month: "Feb", sales: 150 },
 *     { month: "Mar", sales: 200 },
 *   ]}
 *   xKey="month"
 *   yKey="sales"
 * />
 * ```
 */
export const LineChart = createChart<LineChartProps>("line", "LineChart");
