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
