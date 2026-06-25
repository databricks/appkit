// ============================================================================
// Chart Components
// ============================================================================
// These components support both JSON and Arrow data formats with a single API.
// They automatically select the best format based on data size, or you can
// explicitly specify `format="json"` or `format="arrow"`.

export { AreaChart } from "./area";
export { BarChart } from "./bar";
export { HeatmapChart } from "./heatmap";
export { LineChart } from "./line";
export { DonutChart, PieChart } from "./pie";
export { RadarChart } from "./radar";
export { ScatterChart } from "./scatter";

// ============================================================================
// Chart Engine (ECharts ⇄ Plotly)
// ============================================================================
// Every chart above renders with Apache ECharts by default. Opt into Plotly
// per-chart with `engine="plotly"`, or app-wide with `<ChartEngineProvider>`.
// Plotly requires the `react-plotly.js` + `plotly.js-dist-min` peer deps.

export { ChartEngineProvider, useChartEngine } from "./engine";

// ============================================================================
// Plotly (experimental)
// ============================================================================
// `PlotlyChart` is a generic escape hatch exposing Plotly's full trace API for
// chart types the unified charts don't model (3D, sankey, sunburst, …).
// `PlotlyBaseChart` is the engine renderer and `buildPlotly*` its builders.

export {
  buildPlotlyCartesian,
  buildPlotlyHeatmap,
  buildPlotlyPie,
  buildPlotlyRadar,
  PlotlyBaseChart,
  type PlotlyBaseChartProps,
  type PlotlyCartesianContext,
  PlotlyChart,
  type PlotlyChartProps,
  type PlotlyContext,
  type PlotlyFigure,
  type PlotlyHeatmapContext,
  type PlotlyRow,
  toRowObjects,
} from "./plotly";

// ============================================================================
// Base Components & Utilities
// ============================================================================

export {
  type UseChartDataOptions,
  type UseChartDataResult,
  useChartData,
} from "../hooks/use-chart-data";
export { createChart } from "./create-chart";
export { BaseChart, type BaseChartProps } from "./echarts/base";
export { LoadingSkeleton, ResourceWaitingPlaceholder } from "./loading";
export { ChartWrapper, type ChartWrapperProps } from "./wrapper";

// ============================================================================
// Data Normalization
// ============================================================================

export {
  type NormalizedHeatmapData,
  normalizeChartData,
  normalizeHeatmapData,
} from "./normalize";

// ============================================================================
// Shared Constants
// ============================================================================

export {
  // Color palette CSS variables
  CHART_COLOR_VARS,
  CHART_COLOR_VARS_CATEGORICAL,
  CHART_COLOR_VARS_DIVERGING,
  CHART_COLOR_VARS_SEQUENTIAL,
  // Field detection patterns
  DATE_FIELD_PATTERNS,
  // Fallback colors
  FALLBACK_COLORS_CATEGORICAL,
  FALLBACK_COLORS_DIVERGING,
  FALLBACK_COLORS_SEQUENTIAL,
  METADATA_DATE_PATTERNS,
  NAME_FIELD_PATTERNS,
} from "./constants";

// ============================================================================
// Theme Hooks
// ============================================================================

export {
  useAllThemeColors,
  useChartUITokens,
  useThemeColors,
} from "./theme";

// ============================================================================
// Utilities
// ============================================================================

export {
  createTimeSeriesData,
  formatLabel,
  sortTimeSeriesAscending,
  toChartArray,
  toChartValue,
  truncateLabel,
} from "./utils";

// ============================================================================
// Option Builders (for advanced customization)
// ============================================================================

export {
  buildCartesianOption,
  buildHeatmapOption,
  buildHorizontalBarOption,
  buildPieOption,
  buildRadarOption,
  type CartesianContext,
  type HeatmapContext,
  type OptionBuilderContext,
} from "./echarts/options";

// ============================================================================
// Types
// ============================================================================

export type {
  AreaChartProps,
  AreaChartSpecificProps,
  // Chart-specific props
  BarChartProps,
  // Specific props interfaces
  BarChartSpecificProps,
  // Base props
  ChartBaseProps,
  ChartColorPalette,
  ChartData,
  ChartEngine,
  ChartType,
  ChartUITokens,
  // Data formats
  DataFormat,
  DataProps,
  DonutChartProps,
  HeatmapChartProps,
  HeatmapChartSpecificProps,
  LineChartProps,
  LineChartSpecificProps,
  NormalizedChartData,
  NormalizedChartDataBase,
  Orientation,
  PieChartProps,
  PieChartSpecificProps,
  QueryProps,
  RadarChartProps,
  RadarChartSpecificProps,
  ScatterChartProps,
  ScatterChartSpecificProps,
  UnifiedChartProps,
} from "./types";

// Type guards
export { isArrowTable, isDataProps, isQueryProps } from "./types";
