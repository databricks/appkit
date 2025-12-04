import { Label, Pie, PieChart as RechartsPieChart } from "recharts";
import { ChartTooltipDefault } from "../chart-tooltip";
import { ChartWrapper } from "../chart-wrapper";
import { ChartContainer } from "../../ui/chart";
import { detectFields, generateChartConfig } from "../utils";
import type { PieChartProps } from "./types";

/**
 * Production-ready pie chart with automatic data fetching and state management
 * @param props - Props for the PieChart component
 * @returns - The rendered chart component with error boundary
 * @example
 * // Simple usage
 * <PieChart queryKey="top_contributors" parameters={{ limit: 10 }} />
 * @example
 * // With data transformation
 * <PieChart queryKey="top_contributors" parameters={{ limit: 10 }} transformer={(data) => data.map((d) => ({ name: d.name, value: d.value }))} />
 * @example
 * // With full control mode
 * <PieChart queryKey="top_contributors" parameters={{ limit: 10 }}>
 *  <Pie dataKey="value" fill="red" />
 * </BarChart>
 */
export function PieChart(props: PieChartProps) {
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
    innerRadius = 0,
    showLabel = true,
    labelField,
    valueField,
    ...restProps
  } = props;

  return (
    <ChartWrapper
      queryKey={queryKey}
      parameters={parameters}
      transformer={transformer}
      ariaLabel={ariaLabel}
      testId={testId || `pie-chart-${queryKey}`}
      height={height}
      className={className}
    >
      {(data) => {
        // full control mode
        if (children) {
          return (
            <ChartContainer config={chartConfig || {}}>
              <RechartsPieChart {...restProps}>{children}</RechartsPieChart>
            </ChartContainer>
          );
        }

        // opinionated mode - auto-detect fields if not provided
        const { xField, yFields } = detectFields(data, "horizontal");
        const detectedLabelField = labelField || xField;
        const detectedValueField = valueField || yFields[0];

        // generate config
        const sliceNames = data.map(
          (item) => item[detectedLabelField] || "unknown",
        );
        const config = chartConfig || generateChartConfig(sliceNames);

        // fill color to each slice
        const processedData = data.map((item, index) => ({
          ...item,
          fill: `var(--color-${item[detectedLabelField] || `slice-${index}`})`,
        }));

        // calculate total for center label
        const total = data.reduce(
          (acc, curr) => acc + (Number(curr[detectedValueField]) || 0),
          0,
        );

        return (
          <ChartContainer config={config}>
            <RechartsPieChart {...restProps}>
              <ChartTooltipDefault config={config} hideLabel={true} />

              <Pie
                data={processedData}
                dataKey={detectedValueField}
                nameKey={detectedLabelField}
                innerRadius={innerRadius}
                strokeWidth={5}
              >
                {showLabel && (
                  <Label
                    content={({ viewBox }) => {
                      if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                        return (
                          <text
                            x={viewBox.cx}
                            y={viewBox.cy}
                            textAnchor="middle"
                            dominantBaseline="middle"
                          >
                            <tspan
                              x={viewBox.cx}
                              y={viewBox.cy}
                              className="fill-foreground text-3xl font-bold"
                            >
                              {total.toLocaleString()}
                            </tspan>
                            <tspan
                              x={viewBox.cx}
                              y={(viewBox.cy || 0) + 24}
                              className="fill-muted-foreground"
                            >
                              Total
                            </tspan>
                          </text>
                        );
                      }
                    }}
                  />
                )}
              </Pie>
            </RechartsPieChart>
          </ChartContainer>
        );
      }}
    </ChartWrapper>
  );
}
