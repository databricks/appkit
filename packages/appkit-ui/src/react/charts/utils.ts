import type { ChartClickDatum } from "./types";

// ============================================================================
// Chart Utility Functions
// ============================================================================

/**
 * Converts a value to a chart-compatible type.
 * Handles BigInt conversion (Arrow can return BigInt64Array values).
 * Handles Date objects by converting to timestamps.
 */
export function toChartValue(value: unknown): string | number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return String(value);
}

/**
 * Converts an array of values to chart-compatible types.
 */
export function toChartArray(data: unknown[]): (string | number)[] {
  if (data.length === 0) return [];
  return data.map(toChartValue);
}

/**
 * Formats a field name into a human-readable label.
 * Handles camelCase, snake_case, acronyms, and ALL_CAPS.
 * E.g., "totalSpend" -> "Total Spend", "user_name" -> "User Name",
 *       "userID" -> "User Id", "TOTAL_SPEND" -> "Total Spend"
 */
export function formatLabel(field: string): string {
  return (
    field
      // Handle consecutive uppercase followed by lowercase (e.g., HTTPUrl → HTTP Url)
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      // Handle lowercase followed by uppercase (e.g., totalSpend → total Spend)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      // Replace underscores with spaces
      .replace(/_/g, " ")
      // Collapse multiple spaces into one
      .replace(/\s+/g, " ")
      // Normalize to title case
      .toLowerCase()
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .trim()
  );
}

/**
 * Escapes HTML special characters to prevent XSS.
 * Required for ECharts function formatters: unlike string-template
 * formatters, their return values are injected as raw HTML into the
 * tooltip DOM.
 *
 * Only for HTML tooltip contexts; do NOT use on canvas-rendered
 * axis/series label formatters — canvas text is not HTML and would
 * display literal entities (e.g. "&amp;").
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Truncates a label to a maximum length with ellipsis.
 */
export function truncateLabel(value: string, maxLength = 15): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

/**
 * Creates time-series data pairs for ECharts.
 */
export function createTimeSeriesData(
  xData: (string | number)[],
  yData: (string | number)[],
): [string | number, string | number][] {
  const len = xData.length;
  const result: [string | number, string | number][] = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = [xData[i], yData[i]];
  }
  return result;
}

/**
 * Sorts numeric x-data in ascending order, reordering y-data to match.
 * Also coerces numeric string x-values to numbers.
 */
export function sortNumericAscending(
  xData: (string | number)[],
  yDataMap: Record<string, (string | number)[]>,
  yFields: string[],
): {
  xData: (string | number)[];
  yDataMap: Record<string, (string | number)[]>;
} {
  if (xData.length <= 1) {
    return { xData, yDataMap };
  }

  const indices = xData.map((_, i) => i);
  indices.sort((a, b) => Number(xData[a]) - Number(xData[b]));

  const sortedXData = indices.map((i) => Number(xData[i]));
  const sortedYDataMap: Record<string, (string | number)[]> = {};
  for (const key of yFields) {
    const original = yDataMap[key];
    sortedYDataMap[key] = indices.map((i) => original[i]);
  }

  return { xData: sortedXData, yDataMap: sortedYDataMap };
}

/**
 * Maps a raw ECharts click-event `params` object into a public
 * {@link ChartClickDatum}.
 *
 * This is the single boundary that keeps ECharts types out of appkit-ui's
 * public API: the input is typed `unknown` (echarts-for-react passes the event
 * payload loosely) and every field is read defensively via a narrowed local
 * cast rather than by importing an ECharts type such as `CallbackDataParams` or
 * `ECElementEvent`.
 *
 * Field handling:
 * - `name` → coerced to a string, falling back to `""` when missing.
 * - `value` → passed through when it is a `number` or `string`; arrays,
 *   objects, and missing values become `null`.
 * - `seriesName` → kept when it is a string, otherwise left `undefined`.
 * - `dataIndex` / `seriesIndex` → kept when numeric, otherwise `-1`.
 * - `raw` → the entire original `params` object, untouched.
 *
 * @param params - The raw ECharts click-event payload (untyped at our boundary).
 * @returns A normalized, ECharts-free {@link ChartClickDatum}.
 */
export function mapToDatum(params: unknown): ChartClickDatum {
  const p = (
    params !== null && typeof params === "object" ? params : {}
  ) as Record<string, unknown>;

  const name = typeof p.name === "string" ? p.name : "";

  const rawValue = p.value;
  const value =
    typeof rawValue === "number" || typeof rawValue === "string"
      ? rawValue
      : null;

  const seriesName =
    typeof p.seriesName === "string" ? p.seriesName : undefined;

  const dataIndex = typeof p.dataIndex === "number" ? p.dataIndex : -1;
  const seriesIndex = typeof p.seriesIndex === "number" ? p.seriesIndex : -1;

  return {
    name,
    value,
    seriesName,
    dataIndex,
    seriesIndex,
    raw: params,
  };
}

/**
 * Sorts time-series data in ascending chronological order.
 */
export function sortTimeSeriesAscending(
  xData: (string | number)[],
  yDataMap: Record<string, (string | number)[]>,
  yFields: string[],
): {
  xData: (string | number)[];
  yDataMap: Record<string, (string | number)[]>;
} {
  if (xData.length <= 1) {
    return { xData, yDataMap };
  }

  const first = xData[0];
  const last = xData[xData.length - 1];

  if (typeof first === "number" && typeof last === "number" && first > last) {
    const indices = xData.map((_, i) => i);
    indices.sort((a, b) => (xData[a] as number) - (xData[b] as number));

    const sortedXData = indices.map((i) => xData[i]);
    const sortedYDataMap: Record<string, (string | number)[]> = {};
    for (const key of yFields) {
      const original = yDataMap[key];
      sortedYDataMap[key] = indices.map((i) => original[i]);
    }

    return { xData: sortedXData, yDataMap: sortedYDataMap };
  }

  return { xData, yDataMap };
}
