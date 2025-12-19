import { createChart } from "../create-chart";
import type { LineChartProps } from "../types";

/**
 * Line Chart component.
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * @example Simple usage
 * ```tsx
 * <LineChart
 *   queryKey="revenue_over_time"
 *   parameters={{ period: "monthly" }}
 * />
 * ```
 *
 * @example With custom styling
 * ```tsx
 * <LineChart
 *   queryKey="trends"
 *   parameters={{ metric: "users" }}
 *   smooth={false}
 *   showSymbol={true}
 * />
 * ```
 */
export const LineChart = createChart<LineChartProps>("line", "LineChart");
