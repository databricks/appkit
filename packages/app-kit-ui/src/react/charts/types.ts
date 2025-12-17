import type { Table } from "apache-arrow";

// ============================================================================
// Data Format Types
// ============================================================================

/** Supported data formats for analytics queries */
export type DataFormat = "json" | "arrow" | "auto";

/** Chart orientation */
export type Orientation = "vertical" | "horizontal";

/** Supported chart types */
export type ChartType =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "scatter"
  | "radar"
  | "heatmap";

/** Data that can be passed to unified charts */
export type ChartData = Table | Record<string, unknown>[];

// ============================================================================
// Base Props (shared by all charts)
// ============================================================================

/** Color palette types for different visualization needs */
export type ChartColorPalette = "categorical" | "sequential" | "diverging";

/** Common visual and behavior props for all charts */
export interface ChartBaseProps {
  /** Chart title */
  title?: string;
  /** Show legend */
  showLegend?: boolean;
  /**
   * Color palette to use. Auto-selected based on chart type if not specified.
   * - "categorical": Distinct colors for different categories (bar, pie, line)
   * - "sequential": Gradient for magnitude/intensity (heatmap)
   * - "diverging": Two-tone for positive/negative values
   */
  colorPalette?: ChartColorPalette;
  /** Custom colors for series (overrides colorPalette) */
  colors?: string[];
  /** Chart height in pixels @default 300 */
  height?: number;
  /** Additional CSS classes */
  className?: string;

  /** X-axis field key. Auto-detected from schema if not provided. */
  xKey?: string;
  /** Y-axis field key(s). Auto-detected from schema if not provided. */
  yKey?: string | string[];

  /** Accessibility label for screen readers */
  ariaLabel?: string;
  /** Test ID for automated testing */
  testId?: string;

  /** Additional ECharts options to merge */
  options?: Record<string, unknown>;
}

// ============================================================================
// Query-based Props (chart fetches data)
// ============================================================================

/** Props for query-based data fetching */
export interface QueryProps extends ChartBaseProps {
  /** Analytics query key registered with analytics plugin */
  queryKey: string;
  /** Query parameters passed to the analytics endpoint */
  parameters?: Record<string, unknown>;
  /**
   * Data format to use
   * - "json": Use JSON format (smaller payloads, simpler)
   * - "arrow": Use Arrow format (faster for large datasets)
   * - "auto": Automatically select based on expected data size
   * @default "auto"
   */
  format?: DataFormat;
  /** Transform raw data before rendering */
  transformer?: <T>(data: T) => T;

  // Discriminator: cannot use direct data with query
  data?: never;
}

// ============================================================================
// Data-based Props (chart receives data externally)
// ============================================================================

/** Props for direct data injection */
export interface DataProps extends ChartBaseProps {
  /** Arrow Table or JSON array */
  data: ChartData;

  // Discriminator: cannot use query props with direct data
  queryKey?: never;
  parameters?: never;
  format?: never;
  transformer?: never;
}

// ============================================================================
// Union Types for Each Chart
// ============================================================================

/** Base union type - either query-based or data-based */
export type UnifiedChartProps = QueryProps | DataProps;

// ============================================================================
// Chart-Specific Props
// ============================================================================

/** Props specific to bar charts */
export interface BarChartSpecificProps {
  /** Chart orientation @default "vertical" */
  orientation?: Orientation;
  /** Stack bars */
  stacked?: boolean;
}

/** Props specific to line charts */
export interface LineChartSpecificProps {
  /** Chart orientation @default "vertical" */
  orientation?: Orientation;
  /** Show data point symbols @default false */
  showSymbol?: boolean;
  /** Smooth line curves @default true */
  smooth?: boolean;
}

/** Props specific to area charts */
export interface AreaChartSpecificProps {
  /** Chart orientation @default "vertical" */
  orientation?: Orientation;
  /** Show data point symbols @default false */
  showSymbol?: boolean;
  /** Smooth line curves @default true */
  smooth?: boolean;
  /** Stack areas @default false */
  stacked?: boolean;
}

/** Props specific to scatter charts */
export interface ScatterChartSpecificProps {
  /** Symbol size @default 8 */
  symbolSize?: number;
}

/** Props specific to pie/donut charts */
export interface PieChartSpecificProps {
  /** Inner radius for donut charts (0-100%) @default 0 */
  innerRadius?: number;
  /** Show labels on slices @default true */
  showLabels?: boolean;
  /** Label position @default "outside" */
  labelPosition?: "outside" | "inside" | "center";
}

/** Props specific to radar charts */
export interface RadarChartSpecificProps {
  /** Show area fill @default true */
  showArea?: boolean;
}

/** Props specific to heatmap charts */
export interface HeatmapChartSpecificProps {
  /**
   * Field key for the Y-axis categories.
   * For heatmaps, data should have: xKey (column), yAxisKey (row), and yKey (value).
   */
  yAxisKey?: string;
  /** Min value for color scale (auto-detected if not provided) */
  min?: number;
  /** Max value for color scale (auto-detected if not provided) */
  max?: number;
  /** Show value labels on cells @default false */
  showLabels?: boolean;
}

// ============================================================================
// Complete Chart Props (union + specific)
// ============================================================================

export type BarChartProps = (QueryProps | DataProps) & BarChartSpecificProps;
export type LineChartProps = (QueryProps | DataProps) & LineChartSpecificProps;
export type AreaChartProps = (QueryProps | DataProps) & AreaChartSpecificProps;
export type ScatterChartProps = (QueryProps | DataProps) &
  ScatterChartSpecificProps;
export type PieChartProps = (QueryProps | DataProps) & PieChartSpecificProps;
export type DonutChartProps = (QueryProps | DataProps) & PieChartSpecificProps;
export type RadarChartProps = (QueryProps | DataProps) &
  RadarChartSpecificProps;
export type HeatmapChartProps = (QueryProps | DataProps) &
  HeatmapChartSpecificProps;

// ============================================================================
// Internal Types
// ============================================================================

/** Base normalized data shared by all chart types */
export interface NormalizedChartDataBase {
  xData: (string | number)[];
  xField: string;
  yFields: string[];
  chartType: "timeseries" | "categorical";
}

/** Normalized chart data for rendering (standard charts) */
export interface NormalizedChartData extends NormalizedChartDataBase {
  yDataMap: Record<string, (string | number)[]>;
}

/** Type guard to check if data is an Arrow Table */
export function isArrowTable(data: ChartData): data is Table {
  return (
    data !== null &&
    typeof data === "object" &&
    "schema" in data &&
    "numRows" in data &&
    typeof (data as Table).getChild === "function"
  );
}

/** Type guard to check if props are query-based */
export function isQueryProps(props: UnifiedChartProps): props is QueryProps {
  return (
    "queryKey" in props &&
    typeof props.queryKey === "string" &&
    props.queryKey.length > 0
  );
}

/** Type guard to check if props are data-based */
export function isDataProps(props: UnifiedChartProps): props is DataProps {
  return "data" in props && props.data != null;
}
