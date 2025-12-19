import { BaseChart } from "./base";
import type { ChartType, UnifiedChartProps } from "./types";
import { ChartWrapper } from "./wrapper";

/**
 * Factory function to create chart components.
 * Eliminates boilerplate by generating components with the same pattern.
 *
 * @param chartType - The ECharts chart type
 * @param displayName - Component display name for React DevTools
 * @returns A typed chart component
 *
 * @example
 * ```tsx
 * export const BarChart = createChart<BarChartProps>("bar", "BarChart");
 * export const LineChart = createChart<LineChartProps>("line", "LineChart");
 * ```
 */
export function createChart<TProps extends UnifiedChartProps>(
  chartType: ChartType,
  displayName: string,
) {
  const Component = (props: TProps) => {
    const {
      // Query props
      queryKey,
      parameters,
      format,
      transformer,
      // Data props
      data,
      // Common props
      height = 300,
      className,
      ariaLabel,
      testId,
      // All remaining props pass through to BaseChart
      ...chartProps
    } = props as TProps & {
      queryKey?: string;
      parameters?: Record<string, unknown>;
      format?: string;
      transformer?: unknown;
      data?: unknown;
      height?: number;
      className?: string;
      ariaLabel?: string;
      testId?: string;
    };

    const wrapperProps =
      data !== undefined
        ? { data, height, className, ariaLabel, testId }
        : {
            queryKey: queryKey as string,
            parameters,
            format,
            transformer,
            height,
            className,
            ariaLabel,
            testId: testId ?? `${chartType}-chart-${queryKey}`,
          };

    return (
      <ChartWrapper {...wrapperProps}>
        {(chartData) => (
          <BaseChart
            data={chartData}
            chartType={chartType}
            height={height}
            className={className}
            {...chartProps}
          />
        )}
      </ChartWrapper>
    );
  };

  Component.displayName = displayName;
  return Component;
}
