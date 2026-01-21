import { createChart } from "../create-chart";
import type { ScatterChartProps } from "../types";

/**
 * Scatter Chart component for correlation and distribution visualization.
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper.
 *
 * @example Query mode with parameters
 * ```tsx
 * <ScatterChart
 *   queryKey="correlation_data"
 *   parameters={{ metrics: ["revenue", "growth"] }}
 *   xKey="revenue"
 *   yKey="growth"
 * />
 * ```
 *
 * @example With custom symbol size
 * ```tsx
 * <ScatterChart
 *   queryKey="data_points"
 *   parameters={{}}
 *   xKey="x_value"
 *   yKey="y_value"
 *   symbolSize={12}
 * />
 * ```
 */
export const ScatterChart = createChart<ScatterChartProps>(
  "scatter",
  "ScatterChart",
);
