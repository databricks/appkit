import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltipDefault } from "../chart-tooltip";
import { ChartWrapper } from "../chart-wrapper";
import { ChartContainer } from "../ui/chart";
import { detectFields, formatXAxisTick, generateChartConfig } from "../utils";
import type { LineChartProps } from "./types";

/**
 * Production-ready line chart with automatic data fetching and state management
 * @param props - Props for the LineChart component
 * @returns - The rendered chart component with error boundary
 * @example
 * // Simple usage
 * <LineChart queryKey="top_contributors" parameters={{ limit: 10 }} />
 * @example
 * // With data transformation
 * <LineChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
 * @example
 * // With full control mode
 * <LineChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 *  <Line dataKey="value" fill="red" />
 * </LineChart>
 */
export function LineChart(props: LineChartProps) {
  const {
    queryKey,
    parameters,
    transformer,
    children,
    chartConfig,
    ariaLabel,
    testId,
    height = "300px",
    className,
    curveType = "monotone",
    showDots = false,
    strokeWidth = 2,
    ...restProps
  } = props;

  return (
    <ChartWrapper
      queryKey={queryKey}
      parameters={parameters}
      transformer={transformer}
      ariaLabel={ariaLabel}
      testId={testId || `line-chart-${queryKey}`}
      height={height}
      className={className}
    >
      {(data) => {
        // full control mode
        if (children) {
          return (
            <ChartContainer config={chartConfig || {}}>
              <RechartsLineChart data={data} {...restProps}>
                {children}
              </RechartsLineChart>
            </ChartContainer>
          );
        }

        // opinionated mode
        const { xField, yFields } = detectFields(data, "vertical");
        const config = chartConfig || generateChartConfig(yFields);
        return (
          <ChartContainer config={config}>
            <RechartsLineChart
              data={data}
              margin={{ left: 12, right: 12 }}
              {...restProps}
            >
              <CartesianGrid vertical={false} />

              <XAxis
                dataKey={xField}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => formatXAxisTick(value, false)}
              />

              <YAxis hide />

              <ChartTooltipDefault config={config} indicator="line" />

              {yFields.map((field) => (
                <Line
                  key={field}
                  dataKey={field}
                  type={curveType}
                  stroke={`var(--color-${field})`}
                  strokeWidth={strokeWidth}
                  dot={showDots}
                />
              ))}
            </RechartsLineChart>
          </ChartContainer>
        );
      }}
    </ChartWrapper>
  );
}
