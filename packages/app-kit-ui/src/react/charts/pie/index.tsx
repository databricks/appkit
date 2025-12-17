import { createChart } from "../create-chart";
import type { DonutChartProps, PieChartProps } from "../types";

/**
 * Pie Chart component.
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * @example Simple usage
 * ```tsx
 * <PieChart
 *   queryKey="market_share"
 *   parameters={{ category: "tech" }}
 * />
 * ```
 *
 * @example With custom labels
 * ```tsx
 * <PieChart
 *   queryKey="distribution"
 *   showLabels={true}
 *   labelPosition="inside"
 * />
 * ```
 */
export const PieChart = createChart<PieChartProps>("pie", "PieChart");

/**
 * Donut Chart component (Pie chart with inner radius).
 * Supports both JSON and Arrow data formats with automatic format selection.
 *
 * @example Simple usage
 * ```tsx
 * <DonutChart
 *   queryKey="budget_allocation"
 *   parameters={{ year: 2024 }}
 * />
 * ```
 *
 * @example Custom inner radius
 * ```tsx
 * <DonutChart
 *   queryKey="progress"
 *   innerRadius={60}
 * />
 * ```
 */
export const DonutChart = createChart<DonutChartProps>("donut", "DonutChart");
