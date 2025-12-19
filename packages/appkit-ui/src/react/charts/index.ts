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
// Base Components & Utilities
// ============================================================================

export {
  useChartData,
  type UseChartDataOptions,
  type UseChartDataResult,
} from "../hooks/use-chart-data";
export { BaseChart, type BaseChartProps } from "./base";
export { createChart } from "./create-chart";
export { ChartWrapper, type ChartWrapperProps } from "./wrapper";

// ============================================================================
// Data Normalization
// ============================================================================

export {
  normalizeChartData,
  normalizeHeatmapData,
  type NormalizedHeatmapData,
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
  METADATA_DATE_PATTERNS,
  NAME_FIELD_PATTERNS,
  // Fallback colors
  FALLBACK_COLORS,
  FALLBACK_COLORS_CATEGORICAL,
  FALLBACK_COLORS_DIVERGING,
  FALLBACK_COLORS_SEQUENTIAL,
} from "./constants";

// ============================================================================
// Theme Hooks
// ============================================================================

export {
  useAllThemeColors,
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
} from "./options";

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
  ChartType,
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
