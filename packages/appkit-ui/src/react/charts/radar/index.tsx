import { createChart } from "../create-chart";
import type { RadarChartProps } from "../types";

/**
 * Radar Chart component.
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * @example Simple usage
 * ```tsx
 * <RadarChart
 *   queryKey="skills_assessment"
 *   parameters={{ userId: "123" }}
 * />
 * ```
 *
 * @example With custom styling
 * ```tsx
 * <RadarChart
 *   queryKey="performance_metrics"
 *   showArea={true}
 * />
 * ```
 */
export const RadarChart = createChart<RadarChartProps>("radar", "RadarChart");
