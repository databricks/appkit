import {
  Area,
  CartesianGrid,
  AreaChart as RechartsAreaChart,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer } from "../../ui/chart";
import { ChartTooltipDefault } from "../chart-tooltip";
import { ChartWrapper } from "../chart-wrapper";
import { detectFields, formatXAxisTick, generateChartConfig } from "../utils";
import type { AreaChartProps } from "./types";

/**
 * Production-ready area chart with automatic data fetching and state management
 * @param props - Props for the AreaChart component
 * @returns - The rendered chart component with error boundary
 * @example
 * // Simple usage
 * <AreaChart queryKey="top_contributors" parameters={{ limit: 10 }} />
 * @example
 * // With custom data transformation
 * <AreaChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
 * @example
 * // With full control mode
 * <AreaChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 *  <Area dataKey="value" fill="red" />
 * </AreaChart>
 */
export function AreaChart(props: AreaChartProps) {
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
    curveType = "natural",
    ...restProps
  } = props;

  return (
    <ChartWrapper
      queryKey={queryKey}
      parameters={parameters}
      transformer={transformer}
      ariaLabel={ariaLabel}
      testId={testId || `area-chart-${queryKey}`}
      height={height}
      className={className}
    >
      {(data) => {
        // full control mode
        if (children) {
          return (
            <ChartContainer config={chartConfig || {}}>
              <RechartsAreaChart data={data} {...restProps}>
                {children}
              </RechartsAreaChart>
            </ChartContainer>
          );
        }
        // opinionated mode
        const { xField, yFields } = detectFields(data, "vertical");
        const config = chartConfig || generateChartConfig(yFields);
        return (
          <ChartContainer config={config}>
            <RechartsAreaChart
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
              <ChartTooltipDefault config={config} />
              <Area
                dataKey={yFields[0]}
                type={curveType}
                fill={`var(--color-${yFields[0]})`}
                fillOpacity={0.4}
                stroke={`var(--color-${yFields[0]})`}
              />
            </RechartsAreaChart>
          </ChartContainer>
        );
      }}
    </ChartWrapper>
  );
}
