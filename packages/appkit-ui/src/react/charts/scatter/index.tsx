import { createChart } from "../create-chart";
import type { ScatterChartProps } from "../types";

/**
 * Scatter Chart component.
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * @example Simple usage
 * ```tsx
 * <ScatterChart
 *   queryKey="correlation_data"
 *   parameters={{ metrics: ["revenue", "growth"] }}
 * />
 * ```
 *
 * @example With custom symbol size
 * ```tsx
 * <ScatterChart
 *   queryKey="data_points"
 *   symbolSize={12}
 * />
 * ```
 */
export const ScatterChart = createChart<ScatterChartProps>(
  "scatter",
  "ScatterChart",
);
