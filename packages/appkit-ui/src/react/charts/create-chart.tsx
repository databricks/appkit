import type { ComponentType } from "react";
import { BaseChart, type BaseChartProps } from "./echarts/base";
import { useChartEngine } from "./engine";
import { PlotlyBaseChart } from "./plotly/base";
import type { ChartEngine, ChartType, UnifiedChartProps } from "./types";
import { ChartWrapper } from "./wrapper";

/**
 * Renderer registry. Each engine provides a Base component with the same
 * `BaseChartProps` surface, so the factory only has to pick one. Add a new
 * engine by dropping a renderer into `./<engine>/base` and registering it here.
 *
 * Note: both renderers are imported statically, so any chart pulls both engines
 * into the bundle. Swap these for `lazy(() => import(...))` to load an engine
 * only when it's used.
 */
const RENDERERS: Record<ChartEngine, ComponentType<BaseChartProps>> = {
  echarts: BaseChart,
  plotly: PlotlyBaseChart as ComponentType<BaseChartProps>,
};

/**
 * Factory for chart components. Generates a typed component that fetches data
 * via {@link ChartWrapper} and renders it with the selected engine.
 *
 * The engine is resolved per render: the `engine` prop wins, otherwise the
 * value from `<ChartEngineProvider>` (defaulting to "echarts").
 *
 * @param chartType - The chart type (bar, line, …)
 * @param displayName - Component display name for React DevTools
 *
 * @example
 * ```tsx
 * export const BarChart = createChart<BarChartProps>("bar", "BarChart");
 *
 * <BarChart queryKey="revenue" />               // ECharts (default)
 * <BarChart engine="plotly" queryKey="revenue" /> // Plotly
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
      // Engine selection (stripped — renderers don't take it)
      engine,
      // Common props
      height = 300,
      className,
      ariaLabel,
      testId,
      // All remaining props pass through to the renderer
      ...chartProps
    } = props as TProps & {
      queryKey?: string;
      parameters?: Record<string, unknown>;
      format?: string;
      transformer?: unknown;
      data?: unknown;
      engine?: ChartEngine;
      height?: number;
      className?: string;
      ariaLabel?: string;
      testId?: string;
    };

    const contextEngine = useChartEngine();
    const Renderer = RENDERERS[engine ?? contextEngine];

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
          <Renderer
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
