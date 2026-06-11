// Type-only import: erased at compile time, does not pull the full echarts
// bundle in. The `ECharts` type is used for the stored ECharts instance ref.
import type { ECharts } from "echarts";
import {
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
} from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/lib/core";
import { useCallback, useMemo, useRef } from "react";
import { normalizeChartData, normalizeHeatmapData } from "./normalize";
import {
  buildCartesianOption,
  buildHeatmapOption,
  buildHorizontalBarOption,
  buildPieOption,
  buildRadarOption,
  type OptionBuilderContext,
} from "./options";
import { useChartUITokens, useThemeColors } from "./theme";
import type {
  ChartColorPalette,
  ChartData,
  ChartType,
  Orientation,
} from "./types";

// ============================================================================
// ECharts Registration (modular imports for tree-shaking)
// ============================================================================
// Only the chart types and components used by the option builders in
// `options.ts` are registered. Importing from `echarts/core` instead of the
// full `echarts` entry keeps unused chart types (graph, sankey, gauge, ...)
// out of consumer bundles.
//
// If you add a new chart type or use a new ECharts feature (e.g. dataZoom,
// toolbox, markLine), register it here. Consumers passing custom `options`
// that need extra features can register them in their own app via
// `import { use } from "echarts/core"`.
//
// Note: tooltip-driven axisPointer is bundled with `TooltipComponent`, so no
// explicit AxisPointerComponent registration is needed.
//
// This `use()` call must stay co-located in the same module as `BaseChart`:
// `package.json#sideEffects` declares JS modules side-effect free, so moving
// registration to a separate import-for-side-effect module would let bundlers
// drop it during tree-shaking.
echarts.use([
  // Series types used by the option builders
  LineChart, // line + area charts (area = line with areaStyle)
  BarChart, // bar + horizontal bar charts
  PieChart, // pie + donut charts
  ScatterChart,
  HeatmapChart,
  RadarChart,
  // Components referenced by built options
  TitleComponent, // `title`
  TooltipComponent, // `tooltip`
  LegendComponent, // `legend`
  GridComponent, // `grid` / `xAxis` / `yAxis`
  VisualMapComponent, // `visualMap` (heatmap color scale)
  // Features
  LegacyGridContainLabel, // `grid.containLabel` (cartesian option builder)
  // Renderer (BaseChart always renders with `renderer: "canvas"`)
  CanvasRenderer,
]);

// ============================================================================
// Palette Selection
// ============================================================================

/**
 * Determines the appropriate color palette for a chart type.
 * - Heatmaps use sequential (low → high intensity)
 * - All other charts use categorical (distinct categories)
 */
function getDefaultPalette(chartType: ChartType): ChartColorPalette {
  switch (chartType) {
    case "heatmap":
      return "sequential";
    default:
      return "categorical";
  }
}

// ============================================================================
// Component Props
// ============================================================================

export interface BaseChartProps {
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
  /**
   * Color palette to use. Auto-selected based on chart type if not specified.
   * - "categorical": Distinct colors for different categories (bar, pie, line)
   * - "sequential": Gradient for magnitude (heatmap)
   * - "diverging": Two-tone for positive/negative (correlation)
   */
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
  /**
   * Additional ECharts options to merge.
   *
   * Only the built-in feature set is registered by this package, so options
   * referencing extra ECharts features (`dataZoom`, `toolbox`, `markLine`,
   * `markArea`, `graphic`, `dataset`, top-level `axisPointer`, ...) require
   * registering them in your app via `import { use } from "echarts/core"`.
   * This only works when your `echarts` resolves to the same module
   * instance/version as this package's (the registry is a singleton;
   * duplicate echarts copies won't share registrations).
   */
  options?: Record<string, unknown>;
  /** Additional CSS classes */
  className?: string;
}

// ============================================================================
// Base Chart Component
// ============================================================================

/**
 * Base chart component that handles both Arrow and JSON data.
 * Renders using ECharts for consistent output across both formats.
 */
export function BaseChart({
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
}: BaseChartProps) {
  // Determine the appropriate color palette based on chart type
  const resolvedPalette = colorPalette ?? getDefaultPalette(chartType);
  const themeColors = useThemeColors(resolvedPalette);
  const colors = customColors ?? themeColors;

  const ui = useChartUITokens();

  // Store ECharts instance directly to avoid stale ref issues on unmount
  const echartsInstanceRef = useRef<ECharts | null>(null);

  // Callback ref pattern: captures the ECharts instance when ReactECharts mounts
  // This ensures we always have a stable reference to the actual instance
  const chartRefCallback = useCallback((node: ReactEChartsCore | null) => {
    // Dispose previous instance if component is being replaced
    if (
      echartsInstanceRef.current &&
      !echartsInstanceRef.current.isDisposed()
    ) {
      echartsInstanceRef.current.dispose();
    }

    // Store the new instance
    if (node) {
      echartsInstanceRef.current = node.getEchartsInstance();
    } else {
      // Component unmounting - dispose the stored instance
      if (
        echartsInstanceRef.current &&
        !echartsInstanceRef.current.isDisposed()
      ) {
        echartsInstanceRef.current.dispose();
      }
      echartsInstanceRef.current = null;
    }
  }, []);

  // Memoize data normalization
  const normalized = useMemo(
    () =>
      chartType === "heatmap"
        ? normalizeHeatmapData(data, xKey, yAxisKey, yKey)
        : normalizeChartData(data, xKey, yKey, orientation),
    [data, xKey, yKey, yAxisKey, orientation, chartType],
  );

  // Memoize option building
  const option = useMemo(() => {
    const { xData, yFields, xField, chartType: detectedChartType } = normalized;

    if (xData.length === 0) return null;

    // Determine chart mode first (needed to handle yDataMap)
    const isHeatmap = chartType === "heatmap";

    // Heatmaps use heatmapData instead of yDataMap
    // For other charts, yDataMap is required
    const yDataMap = "yDataMap" in normalized ? normalized.yDataMap : {};

    const baseCtx: OptionBuilderContext = {
      xData,
      yDataMap,
      yFields,
      colors,
      title,
      showLegend,
      xField,
      ui,
    };
    const isPie = chartType === "pie" || chartType === "donut";
    const isRadar = chartType === "radar";
    const isHorizontal =
      !isPie &&
      !isRadar &&
      !isHeatmap &&
      (orientation === "horizontal" ||
        (detectedChartType === "categorical" &&
          !orientation &&
          chartType === "bar"));
    const isTimeSeries =
      detectedChartType === "timeseries" &&
      !isHorizontal &&
      !isRadar &&
      !isHeatmap;

    // Build option based on chart type
    let opt: Record<string, unknown>;

    if (isHeatmap && "yAxisData" in normalized && "heatmapData" in normalized) {
      const heatmapNorm = normalized as {
        yAxisData: (string | number)[];
        heatmapData: [number, number, number][];
        min: number;
        max: number;
      } & typeof normalized;
      opt = buildHeatmapOption({
        ...baseCtx,
        yAxisData: heatmapNorm.yAxisData,
        heatmapData: heatmapNorm.heatmapData,
        min: min ?? heatmapNorm.min,
        max: max ?? heatmapNorm.max,
        showLabels,
      });
    } else if (isRadar) {
      opt = buildRadarOption(baseCtx, showArea);
    } else if (isPie) {
      opt = buildPieOption(
        baseCtx,
        chartType as "pie" | "donut",
        innerRadius,
        showLabels,
        labelPosition,
      );
    } else if (isHorizontal) {
      opt = buildHorizontalBarOption(baseCtx, stacked);
    } else {
      opt = buildCartesianOption({
        ...baseCtx,
        chartType,
        isTimeSeries,
        stacked,
        smooth,
        showSymbol,
        symbolSize,
      });
    }

    // Merge custom options
    return customOptions ? { ...opt, ...customOptions } : opt;
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
    customOptions,
  ]);

  if (!option) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No data
      </div>
    );
  }

  return (
    <ReactEChartsCore
      ref={chartRefCallback}
      echarts={echarts}
      option={option}
      style={{ height }}
      className={className}
      opts={{ renderer: "canvas" }}
      notMerge={false}
      lazyUpdate={true}
    />
  );
}
