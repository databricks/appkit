import {
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart as RechartsRadarChart,
} from "recharts";
import { ChartTooltipDefault } from "../chart-tooltip";
import { ChartWrapper } from "../chart-wrapper";
import { ChartContainer } from "../../ui/chart";
import { detectFields, formatXAxisTick, generateChartConfig } from "../utils";
import type { RadarChartProps } from "./types";

/**
 * Production-ready radar chart with automatic data fetching and state management
 * @param props - Props for the RadarChart component
 * @returns - The rendered chart component with error boundary
 * @example
 * // Simple usage
 * <RadarChart queryKey="top_contributors" parameters={{ limit: 10 }} />
 * @example
 * // With custom data transformation
 * <RadarChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
 * @example
 * // With full control mode
 * <RadarChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 *  <Radar dataKey="value" fill="red" />
 * </RadarChart>
 */
export function RadarChart(props: RadarChartProps) {
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
    fillOpacity = 0.6,
    showDots = false,
    angleField,
    ...restProps
  } = props;

  return (
    <ChartWrapper
      queryKey={queryKey}
      parameters={parameters}
      transformer={transformer}
      ariaLabel={ariaLabel}
      testId={testId || `radar-chart-${queryKey}`}
      height={height}
      className={className}
    >
      {(data) => {
        // full control mode
        if (children) {
          return (
            <ChartContainer config={chartConfig || {}}>
              <RechartsRadarChart data={data} {...restProps}>
                {children}
              </RechartsRadarChart>
            </ChartContainer>
          );
        }

        // opinionated mode
        const { xField, yFields } = detectFields(data, "vertical");
        const detectedAngleField = angleField || xField;
        const config = chartConfig || generateChartConfig(yFields);

        return (
          <ChartContainer config={config}>
            <RechartsRadarChart data={data} {...restProps}>
              <ChartTooltipDefault config={config} />

              <PolarAngleAxis
                dataKey={detectedAngleField}
                tickFormatter={(value) => formatXAxisTick(value, false)}
              />
              <PolarGrid />

              {yFields.map((field) => (
                <Radar
                  key={field}
                  dataKey={field}
                  fill={`var(--color-${field})`}
                  fillOpacity={fillOpacity}
                  stroke={`var(--color-${field})`}
                  dot={
                    showDots
                      ? {
                          r: 4,
                          fillOpacity: 1,
                        }
                      : false
                  }
                />
              ))}
            </RechartsRadarChart>
          </ChartContainer>
        );
      }}
    </ChartWrapper>
  );
}
