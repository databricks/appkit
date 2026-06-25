import type { Config, Layout } from "plotly.js";
import { useMemo } from "react";
import { normalizeChartData, normalizeHeatmapData } from "../normalize";
import { useChartUITokens, useThemeColors } from "../theme";
import type {
  ChartColorPalette,
  ChartData,
  ChartType,
  Orientation,
} from "../types";
import {
  buildPlotlyCartesian,
  buildPlotlyHeatmap,
  buildPlotlyPie,
  buildPlotlyRadar,
  type PlotlyFigure,
} from "./options";
import { Plot } from "./plot";

const DEFAULT_CONFIG: Partial<Config> = {
  responsive: true,
  displaylogo: false,
  displayModeBar: "hover",
};

// ============================================================================
// Palette Selection (mirrors the ECharts BaseChart)
// ============================================================================

function getDefaultPalette(chartType: ChartType): ChartColorPalette {
  return chartType === "heatmap" ? "sequential" : "categorical";
}

// ============================================================================
// Layout Merge
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** Deep-merges the user-provided `options` (layout overrides) into the layout. */
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

// ============================================================================
// Component Props
// ============================================================================

export interface PlotlyBaseChartProps {
  /** Chart data (Arrow Table or JSON array) - format is auto-detected */
  data: ChartData;
  /** Chart type */
  chartType: ChartType;
  /** X-axis field key (auto-detected from schema if not provided) */
  xKey?: string;
  /** Y-axis field key(s) (auto-detected from schema if not provided) */
  yKey?: string | string[];
  /** Chart orientation @default "vertical" */
  orientation?: Orientation;
  /** Chart height in pixels @default 300 */
  height?: number;
  /** Chart title */
  title?: string;
  /** Show legend @default true */
  showLegend?: boolean;
  /** Color palette to use. Auto-selected based on chart type if not specified. */
  colorPalette?: ChartColorPalette;
  /** Custom colors (overrides colorPalette) */
  colors?: string[];
  /** Show data point symbols (line/area charts) @default false */
  showSymbol?: boolean;
  /** Smooth line curves (line/area charts) @default true */
  smooth?: boolean;
  /** Stack series @default false */
  stacked?: boolean;
  /** Symbol size for scatter charts @default 8 */
  symbolSize?: number;
  /** Show area fill for radar charts @default true */
  showArea?: boolean;
  /** Inner radius for pie/donut (0-100) @default 0 */
  innerRadius?: number;
  /** Show labels on pie/donut slices @default true */
  showLabels?: boolean;
  /** Label position for pie/donut @default "outside" */
  labelPosition?: "outside" | "inside" | "center";
  /** Y-axis field key for heatmap (the row dimension) */
  yAxisKey?: string;
  /** Min value for heatmap color scale */
  min?: number;
  /** Max value for heatmap color scale */
  max?: number;
  /** Additional Plotly layout options to deep-merge */
  options?: Record<string, unknown>;
  /** Additional CSS classes */
  className?: string;
}

// ============================================================================
// Plotly Base Chart Component
// ============================================================================

/**
 * Base chart component that renders normalized data with Plotly. This is the
 * Plotly counterpart of the ECharts `BaseChart`: it reuses the same data
 * normalization and theme tokens, so a Plotly chart is a visual drop-in for its
 * ECharts twin while gaining Plotly's richer interactivity.
 */
export function PlotlyBaseChart({
  data,
  chartType,
  xKey,
  yKey,
  orientation,
  height = 300,
  title,
  showLegend = true,
  colorPalette,
  colors: customColors,
  showSymbol = false,
  smooth = true,
  stacked = false,
  symbolSize = 8,
  showArea = true,
  innerRadius = 0,
  showLabels = true,
  labelPosition = "outside",
  yAxisKey,
  min,
  max,
  options: customOptions,
  className,
}: PlotlyBaseChartProps) {
  const resolvedPalette = colorPalette ?? getDefaultPalette(chartType);
  const themeColors = useThemeColors(resolvedPalette);
  const colors = customColors ?? themeColors;
  const ui = useChartUITokens();

  const normalized = useMemo(
    () =>
      chartType === "heatmap"
        ? normalizeHeatmapData(data, xKey, yAxisKey, yKey)
        : normalizeChartData(data, xKey, yKey, orientation),
    [data, xKey, yKey, yAxisKey, orientation, chartType],
  );

  const figure = useMemo<PlotlyFigure | null>(() => {
    const { xData, yFields, xField } = normalized;
    if (xData.length === 0) return null;

    const baseCtx = {
      xData,
      yDataMap: "yDataMap" in normalized ? normalized.yDataMap : {},
      yFields,
      colors,
      title,
      showLegend,
      xField,
      ui,
    };

    const isPie = chartType === "pie" || chartType === "donut";
    const isRadar = chartType === "radar";
    const isHeatmap = chartType === "heatmap";

    if (isHeatmap && "yAxisData" in normalized && "heatmapData" in normalized) {
      const heatmapNorm = normalized as {
        yAxisData: (string | number)[];
        heatmapData: [number, number, number][];
        min: number;
        max: number;
      } & typeof normalized;
      return buildPlotlyHeatmap({
        ...baseCtx,
        yAxisData: heatmapNorm.yAxisData,
        heatmapData: heatmapNorm.heatmapData,
        min: min ?? heatmapNorm.min,
        max: max ?? heatmapNorm.max,
        showLabels,
      });
    }

    if (isRadar) return buildPlotlyRadar(baseCtx, showArea);

    if (isPie) {
      return buildPlotlyPie(
        baseCtx,
        chartType === "donut" || innerRadius > 0,
        innerRadius,
        showLabels,
        labelPosition,
      );
    }

    return buildPlotlyCartesian({
      ...baseCtx,
      chartType,
      orientation: orientation ?? "vertical",
      stacked,
      smooth,
      showSymbol,
      symbolSize,
    });
  }, [
    normalized,
    colors,
    ui,
    title,
    showLegend,
    chartType,
    orientation,
    innerRadius,
    showLabels,
    labelPosition,
    stacked,
    smooth,
    showSymbol,
    symbolSize,
    showArea,
    min,
    max,
  ]);

  if (!figure) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No data
      </div>
    );
  }

  const layout = mergeLayout(figure.layout, customOptions);

  return (
    <Plot
      data={figure.traces}
      layout={layout}
      config={DEFAULT_CONFIG}
      className={className}
      style={{ width: "100%", height }}
      useResizeHandler
    />
  );
}
