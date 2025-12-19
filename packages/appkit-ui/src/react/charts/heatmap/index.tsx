import { createChart } from "../create-chart";
import type { HeatmapChartProps } from "../types";

/**
 * Heatmap Chart component.
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * Data should be in "long format" with three fields:
 * - xKey: X-axis category (columns)
 * - yAxisKey: Y-axis category (rows)
 * - yKey: The numeric value for each cell
 *
 * @example Simple usage
 * ```tsx
 * <HeatmapChart
 *   queryKey="activity_matrix"
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
