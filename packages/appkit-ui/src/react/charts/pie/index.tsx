import { createChart } from "../create-chart";
import type { DonutChartProps, PieChartProps } from "../types";

/**
 * Pie Chart component for proportional data visualization.
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper.
 *
 * @example Query mode
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
 *   parameters={{}}
 *   showLabels={true}
 *   labelPosition="inside"
 * />
 * ```
 */
export const PieChart = createChart<PieChartProps>("pie", "PieChart");

/**
 * Donut Chart component (Pie chart with inner radius).
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper.
 *
 * @example Query mode
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
 *   parameters={{}}
 *   innerRadius={60}
 * />
 * ```
 */
export const DonutChart = createChart<DonutChartProps>("donut", "DonutChart");
