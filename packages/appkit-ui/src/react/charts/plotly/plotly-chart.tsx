import type { Config, Data, Layout } from "plotly.js";
import { type ReactNode, useMemo } from "react";
import { useChartUITokens, useThemeColors } from "../theme";
import type {
  ChartBaseProps,
  ChartData,
  DataFormat,
  DataProps,
} from "../types";
import { ChartWrapper } from "../wrapper";
import { Plot } from "./plot";
import { type PlotlyRow, toRowObjects } from "./rows";

const DEFAULT_CONFIG: Partial<Config> = {
  responsive: true,
  displaylogo: false,
  displayModeBar: "hover",
};

// ============================================================================
// Props
// ============================================================================

interface PlotlyChartCommonProps {
  /**
   * Maps the fetched rows to Plotly traces. This is the escape hatch that
   * unlocks Plotly's full power — 3D (`scatter3d`, `surface`), `sankey`,
   * `sunburst`, `candlestick`, `contour`, geographic maps, and more.
   */
  traces: (rows: PlotlyRow[]) => Data[];
  /** Plotly layout overrides, deep-merged over the theme-aware defaults. */
  layout?: Partial<Layout>;
  /** Plotly config overrides. */
  config?: Partial<Config>;
}

type PlotlyChartQueryProps = PlotlyChartCommonProps &
  Omit<ChartBaseProps, "options"> & {
    queryKey: string;
    parameters?: Record<string, unknown>;
    format?: DataFormat;
    transformer?: <T>(data: T) => T;
    data?: never;
  };

type PlotlyChartDataProps = PlotlyChartCommonProps &
  Omit<ChartBaseProps, "options"> &
  Pick<DataProps, "data"> & {
    queryKey?: never;
    parameters?: never;
    format?: never;
    transformer?: never;
  };

export type PlotlyChartProps = PlotlyChartQueryProps | PlotlyChartDataProps;

// ============================================================================
// Renderer
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function mergeLayout(
  base: Partial<Layout>,
  override?: Record<string, unknown>,
): Partial<Layout> {
  if (!override) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeLayout(existing as Partial<Layout>, value)
        : value;
  }
  return out as Partial<Layout>;
}

function PlotlyChartInner({
  data,
  traces,
  layout,
  config,
  height = 300,
  colorPalette = "categorical",
  className,
}: {
  data: ChartData;
  traces: (rows: PlotlyRow[]) => Data[];
  layout?: Partial<Layout>;
  config?: Partial<Config>;
  height?: number;
  colorPalette?: ChartBaseProps["colorPalette"];
  className?: string;
}) {
  const colors = useThemeColors(colorPalette);
  const ui = useChartUITokens();

  const plotData = useMemo(() => traces(toRowObjects(data)), [traces, data]);

  const mergedLayout = useMemo(() => {
    const themed: Partial<Layout> = {
      autosize: true,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      colorway: colors,
      font: { color: ui.axisTitle },
      margin: { t: 32, r: 16, b: 40, l: 56 },
      hoverlabel: { bgcolor: ui.tooltipBg, font: { color: ui.axisTitle } },
    };
    return mergeLayout(themed, layout);
  }, [colors, ui, layout]);

  return (
    <Plot
      data={plotData}
      layout={mergedLayout}
      config={{ ...DEFAULT_CONFIG, ...config }}
      className={className}
      style={{ width: "100%", height }}
      useResizeHandler
    />
  );
}

/**
 * Generic Plotly chart with full access to the Plotly trace API. Fetches data
 * via the same query/data wrapper as the other AppKit charts, then hands the
 * rows to your `traces` callback so you can render any Plotly chart type.
 *
 * @example Query mode — a 3D scatter from a registered analytics query
 * ```tsx
 * <PlotlyChart
 *   queryKey="metrics"
 *   traces={(rows) => [{
 *     type: "scatter3d",
 *     mode: "markers",
 *     x: rows.map((r) => r.x),
 *     y: rows.map((r) => r.y),
 *     z: rows.map((r) => r.z),
 *   }]}
 * />
 * ```
 */
export function PlotlyChart(props: PlotlyChartProps): ReactNode {
  const {
    traces,
    layout,
    config,
    height = 300,
    colorPalette,
    className,
    ariaLabel,
    testId,
  } = props;

  const wrapperProps =
    "data" in props && props.data !== undefined
      ? { data: props.data, height, className, ariaLabel, testId }
      : {
          queryKey: (props as PlotlyChartQueryProps).queryKey,
          parameters: (props as PlotlyChartQueryProps).parameters,
          format: (props as PlotlyChartQueryProps).format,
          transformer: (props as PlotlyChartQueryProps).transformer,
          height,
          className,
          ariaLabel,
          testId:
            testId ??
            `plotly-chart-${(props as PlotlyChartQueryProps).queryKey}`,
        };

  return (
    <ChartWrapper {...wrapperProps}>
      {(chartData) => (
        <PlotlyChartInner
          data={chartData}
          traces={traces}
          layout={layout}
          config={config}
          height={height}
          colorPalette={colorPalette}
          className={className}
        />
      )}
    </ChartWrapper>
  );
}
