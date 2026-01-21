import { createChart } from "../create-chart";
import type { RadarChartProps } from "../types";

/**
 * Radar Chart component for multi-dimensional data comparison.
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper.
 *
 * @example Query mode with parameters
 * ```tsx
 * <RadarChart
 *   queryKey="skills_assessment"
 *   parameters={{ userId: "123" }}
 *   xKey="skill"
 *   yKey="score"
 * />
 * ```
 *
 * @example With custom styling
 * ```tsx
 * <RadarChart
 *   queryKey="performance_metrics"
 *   parameters={{}}
 *   xKey="metric"
 *   yKey="value"
 *   showArea={true}
 * />
 * ```
 */
export const RadarChart = createChart<RadarChartProps>("radar", "RadarChart");
