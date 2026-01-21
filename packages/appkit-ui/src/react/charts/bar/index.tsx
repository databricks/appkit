import { createChart } from "../create-chart";
import type { BarChartProps } from "../types";

/**
 * Bar Chart component for categorical comparisons.
 * Built on Apache ECharts. Configure via props, NOT children.
 *
 * ⚠️ CRITICAL: This is NOT a Recharts wrapper. Do not use Recharts components as children.
 *
 * @example Query mode with multiple series
 * ```tsx
 * <BarChart
 *   queryKey="revenue_comparison"
 *   parameters={{}}
 *   xKey="quarter"
 *   yKey={["revenue_2023", "revenue_2024"]}
 *   colors={['#3b82f6', '#10b981']}
 *   showLegend
 * />
 * ```
 *
 * @example Common props reference
 * ```tsx
 * <BarChart
 *   queryKey="sales_by_region"
 *   parameters={{}}
 *   xKey="region"                    // X-axis field
 *   yKey={["revenue", "expenses"]}   // Y-axis field(s) - string or string[]
 *   colors={['#40d1f5', '#4462c9']}  // Custom colors
 *   stacked                          // Stack bars
 *   orientation="horizontal"         // "vertical" (default) | "horizontal"
 *   showLegend                       // Show legend
 *   height={400}                     // Height in pixels (default: 300)
 * />
 * ```
 *
 * @example Data mode
 * ```tsx
 * <BarChart
 *   data={[
 *     { category: "A", value: 100 },
 *     { category: "B", value: 200 },
 *   ]}
 *   xKey="category"
 *   yKey="value"
 * />
 * ```
 */
export const BarChart = createChart<BarChartProps>("bar", "BarChart");
