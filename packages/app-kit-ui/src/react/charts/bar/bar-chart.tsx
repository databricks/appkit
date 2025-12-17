import {
  Bar,
  CartesianGrid,
  BarChart as RechartsBarChart,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltipDefault } from "../chart-tooltip";
import { ChartWrapper } from "../chart-wrapper";
import { ChartContainer } from "../../ui/chart";
import { detectFields, formatXAxisTick, generateChartConfig } from "../utils";
import type { BarChartProps } from "./types";

/**
 * Bar chart component with automatic query execution and data visualization.
 *
 * Integrates with the analytics plugin to fetch and display data as a bar chart.
 * Supports automatic field detection, custom transformations, loading states,
 * and error handling out of the box.
 *
 * @param props - Bar chart configuration
 * @param props.queryKey - Analytics query identifier
 * @param props.parameters - Query parameters
 * @param props.transformer - Optional data transformation function
 * @param props.chartConfig - Custom chart configuration (colors, labels)
 * @param props.orientation - Chart orientation: 'vertical' or 'horizontal' (default: vertical)
 * @param props.height - Chart height (default: '300px')
 * @param props.children - Optional custom Bar components for full control
 * @returns Rendered bar chart with loading and error states
 *
 * @example
 * Basic bar chart
 * ```typescript
 * import { BarChart } from '@databricks/app-kit-ui';
 *
 * function TopContributors() {
 *   return (
 *     <BarChart
 *       queryKey="top_contributors"
 *       parameters={{ limit: 10 }}
 *     />
 *   );
 * }
 * ```
 *
 * @example
 * Horizontal bar chart with custom styling
 * ```typescript
 * import { BarChart } from '@databricks/app-kit-ui';
 *
 * function SalesChart() {
 *   return (
 *     <BarChart
 *       queryKey="sales_by_region"
 *       orientation="horizontal"
 *       height="400px"
 *       chartConfig={{
 *         sales: { label: 'Sales', color: '#8884d8' }
 *       }}
 *     />
 *   );
 * }
 * ```
 */
export function BarChart(props: BarChartProps) {
  const {
    queryKey,
    parameters,
    transformer,
    children,
    chartConfig,
    orientation,
    ariaLabel,
    testId,
    height = "300px",
    className,
    ...restProps
  } = props;
  const isHorizontal = orientation === "horizontal";

  return (
    <ChartWrapper
      queryKey={queryKey}
      parameters={parameters}
      transformer={transformer}
      ariaLabel={ariaLabel}
      testId={testId || `bar-chart-${queryKey}`}
      height={height}
      className={className}
    >
      {(data) => {
        // full control mode, only add the data
        if (children) {
          return (
            <ChartContainer config={chartConfig || {}}>
              <RechartsBarChart
                data={data}
                layout={isHorizontal ? "vertical" : "horizontal"}
                {...restProps}
              >
                {children}
              </RechartsBarChart>
            </ChartContainer>
          );
        }

        // opinionated mode, detect fields and generate config
        const { xField, yFields } = detectFields(data, orientation);
        const config = chartConfig || generateChartConfig(yFields);

        return (
          <ChartContainer config={config}>
            <RechartsBarChart
              data={data}
              layout={isHorizontal ? "vertical" : "horizontal"}
              margin={isHorizontal ? { left: 0, right: 20 } : undefined}
              {...restProps}
            >
              <CartesianGrid vertical={!isHorizontal} />

              <XAxis
                type={isHorizontal ? "number" : "category"}
                dataKey={isHorizontal ? yFields[0] : xField}
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                tickFormatter={(value) => formatXAxisTick(value, isHorizontal)}
              />

              {isHorizontal && (
                <YAxis
                  type="category"
                  dataKey={xField}
                  tickLine={false}
                  tickMargin={10}
                  axisLine={false}
                  width={150}
                  tickFormatter={(value) => {
                    const str = String(value).replace(/[<>"'&]/g, "");
                    return str.length > 20 ? `${str.slice(0, 20)}...` : str;
                  }}
                />
              )}

              <ChartTooltipDefault config={config} />
              <Bar
                dataKey={yFields[0]}
                fill={`var(--color-${yFields[0]})`}
                radius={5}
              />
            </RechartsBarChart>
          </ChartContainer>
        );
      }}
    </ChartWrapper>
  );
}
