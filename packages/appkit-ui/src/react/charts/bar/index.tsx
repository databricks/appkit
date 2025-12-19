import { createChart } from "../create-chart";
import type { BarChartProps } from "../types";

/**
 * Bar Chart component.
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * @example Query mode with auto format selection
 * ```tsx
 * <BarChart
 *   queryKey="top_contributors"
 *   parameters={{ limit: 10 }}
 * />
 * ```
 *
 * @example Query mode with explicit Arrow format
 * ```tsx
 * <BarChart
 *   queryKey="spend_data"
 *   parameters={{ startDate, endDate }}
 *   format="arrow"
 * />
 * ```
 *
 * @example Data mode with JSON array
 * ```tsx
 * <BarChart
 *   data={[
 *     { category: "A", value: 100 },
 *     { category: "B", value: 200 },
 *   ]}
 * />
 * ```
 */
export const BarChart = createChart<BarChartProps>("bar", "BarChart");
