import {
  Bar,
  CartesianGrid,
  BarChart as RechartsBarChart,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltipDefault } from "../chart-tooltip";
import { ChartWrapper } from "../chart-wrapper";
import { ChartContainer } from "../ui/chart";
import { detectFields, formatXAxisTick, generateChartConfig } from "../utils";
import type { BarChartProps } from "./types";

/**
 * Production-ready bar chart with automatic data fetching and state management
 * @param props - Props for the BarChart component
 * @returns - The rendered chart component with error boundary
 * @example
 * // Simple usage
 * <BarChart queryKey="top_contributors" parameters={{ limit: 10 }} />
 * @example
 * // With data transformation
 * <BarChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
 * @example
 * // With full control mode
 * <BarChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 *  <Bar dataKey="value" fill="red" />
 * </BarChart>
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
