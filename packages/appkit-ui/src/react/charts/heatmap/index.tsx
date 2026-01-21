import { createChart } from "../create-chart";
import type { HeatmapChartProps } from "../types";

/**
 * Heatmap Chart component for matrix-style data visualization.
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper.
 *
 * Data should be in "long format" with three fields:
 * - xKey: X-axis category (columns)
 * - yAxisKey: Y-axis category (rows)
 * - yKey: The numeric value for each cell
 *
 * @example Query mode
 * ```tsx
 * <HeatmapChart
 *   queryKey="activity_matrix"
 *   parameters={{}}
 *   xKey="day"
 *   yAxisKey="hour"
 *   yKey="count"
 * />
 * ```
 *
 * @example With custom color scale
 * ```tsx
 * <HeatmapChart
 *   queryKey="correlation_matrix"
 *   parameters={{}}
 *   xKey="variable_x"
 *   yAxisKey="variable_y"
 *   yKey="correlation"
 *   min={-1}
 *   max={1}
 *   showLabels={true}
 *   colorPalette="diverging"
 * />
 * ```
 */
export const HeatmapChart = createChart<HeatmapChartProps>(
  "heatmap",
  "HeatmapChart",
);
