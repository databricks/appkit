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

export { formatLabel } from "@/js";

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
 * Axis category labels for the chart being clicked, so index-addressed data
 * (heatmap) can be resolved back to the labels the user actually sees.
 */
interface DatumAxisContext {
  xLabels?: (string | number)[];
  yLabels?: (string | number)[];
}

interface ChartEventInstance {
  getOption(): unknown;
  convertToPixel(
    finder: { seriesIndex: number },
    value: (string | number)[],
  ): unknown;
}

interface ResolvedLinePoint {
  name: string;
  value: [string | number, string | number];
  dataIndex: number;
}

function resolveLineStrokePoint(
  params: Record<string, unknown>,
  axes: DatumAxisContext,
  instance?: ChartEventInstance,
): ResolvedLinePoint | null {
  if (
    params.seriesType !== "line" ||
    params.value !== undefined ||
    !instance ||
    typeof params.seriesIndex !== "number"
  ) {
    return null;
  }

  const event =
    params.event !== null && typeof params.event === "object"
      ? (params.event as Record<string, unknown>)
      : null;
  const clickX = event?.offsetX;
  if (typeof clickX !== "number") return null;

  try {
    const option = instance.getOption();
    if (option === null || typeof option !== "object") return null;

    const series = (option as Record<string, unknown>).series;
    if (!Array.isArray(series)) return null;

    const seriesOption = series[params.seriesIndex];
    if (
      seriesOption === null ||
      typeof seriesOption !== "object" ||
      Array.isArray(seriesOption)
    ) {
      return null;
    }

    const data = (seriesOption as Record<string, unknown>).data;
    if (!Array.isArray(data)) return null;

    let nearest: ResolvedLinePoint | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let dataIndex = 0; dataIndex < data.length; dataIndex++) {
      const item = data[dataIndex];
      const itemRecord =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      const rawValue = itemRecord ? itemRecord.value : item;

      let x: string | number | undefined;
      let y: string | number | undefined;
      if (Array.isArray(rawValue)) {
        if (
          (typeof rawValue[0] === "string" ||
            typeof rawValue[0] === "number") &&
          (typeof rawValue[1] === "string" || typeof rawValue[1] === "number")
        ) {
          x = rawValue[0];
          y = rawValue[1];
        }
      } else if (
        (typeof rawValue === "string" || typeof rawValue === "number") &&
        axes.xLabels?.[dataIndex] !== undefined
      ) {
        x = axes.xLabels[dataIndex];
        y = rawValue;
      }
      if (x === undefined || y === undefined) continue;

      const pixel = instance.convertToPixel(
        { seriesIndex: params.seriesIndex },
        [x, y],
      );
      if (!Array.isArray(pixel) || typeof pixel[0] !== "number") continue;

      const distance = Math.abs(pixel[0] - clickX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = {
          name:
            typeof itemRecord?.name === "string" ? itemRecord.name : String(x),
          value: [x, y],
          dataIndex,
        };
      }
    }

    return nearest;
  } catch {
    return null;
  }
}

/**
 * Maps a raw ECharts click-event `params` object into a public
 * {@link ChartClickDatum}.
 *
 * @param params - The raw ECharts click-event payload (untyped at our boundary).
 * @param axes - Category labels used to resolve index-addressed heatmap data.
 * @param instance - The chart instance used to resolve series-level line clicks.
 * @returns A normalized, ECharts-free {@link ChartClickDatum}.
 */
export function mapToDatum(
  params: unknown,
  axes: DatumAxisContext = {},
  instance?: ChartEventInstance,
): ChartClickDatum {
  const p = (
    params !== null && typeof params === "object" ? params : {}
  ) as Record<string, unknown>;

  const isScalar = (v: unknown): v is number | string =>
    typeof v === "number" || typeof v === "string";

  const linePoint = resolveLineStrokePoint(p, axes, instance);
  const rawValue = linePoint?.value ?? p.value;
  const seriesType =
    typeof p.seriesType === "string" ? p.seriesType : undefined;

  let x: number | string | undefined;
  let y: number | string | undefined;
  let value: number | string | null;

  if (seriesType === "heatmap" && Array.isArray(rawValue)) {
    // `[xIndex, yIndex, value]`: report the cell value
    const labelAt = (
      labels: (string | number)[] | undefined,
      index: unknown,
    ): number | string | undefined => {
      if (!isScalar(index)) return undefined;
      if (typeof index === "number" && labels?.[index] !== undefined) {
        return labels[index];
      }
      return index;
    };
    x = labelAt(axes.xLabels, rawValue[0]);
    y = labelAt(axes.yLabels, rawValue[1]);
    value = isScalar(rawValue[2]) ? rawValue[2] : null;
  } else if (seriesType === "radar") {
    // A radar item holds one value per indicator;
    value = null;
  } else if (Array.isArray(rawValue)) {
    // `[x, y]` (time-series / scatter): split values so callers don't have to re-parse `raw`.
    if (isScalar(rawValue[0])) x = rawValue[0];
    if (isScalar(rawValue[1])) y = rawValue[1];
    value = y ?? null;
  } else {
    value = isScalar(rawValue) ? rawValue : null;
  }

  const name =
    typeof p.name === "string"
      ? p.name
      : (linePoint?.name ?? (x !== undefined ? String(x) : ""));

  const seriesName =
    typeof p.seriesName === "string" ? p.seriesName : undefined;

  const dataIndex =
    typeof p.dataIndex === "number"
      ? p.dataIndex
      : (linePoint?.dataIndex ?? -1);
  const seriesIndex = typeof p.seriesIndex === "number" ? p.seriesIndex : -1;

  return {
    name,
    value,
    x,
    y,
    seriesName,
    dataIndex,
    seriesIndex,
    raw: params,
  };
}

const DATE_STRING_PATTERN = /^\d{4}-\d{2}-\d{2}(?:$|[T\s])/;

function toChronologicalValue(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (!DATE_STRING_PATTERN.test(value)) return null;

  // Spark JSON_ARRAY timestamps commonly use a space between the date and
  // time. Normalize that separator to the ISO form before parsing.
  const timestamp = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Sorts time-series data in ascending chronological order while preserving
 * the correlation between each x value and its y values. Non-date category
 * strings are intentionally left in their source order.
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

  const chronologicalValues = xData.map(toChronologicalValue);
  if (chronologicalValues.some((value) => value === null)) {
    return { xData, yDataMap };
  }

  const indices = xData.map((_, i) => i);
  indices.sort(
    (a, b) =>
      (chronologicalValues[a] as number) - (chronologicalValues[b] as number),
  );

  if (indices.every((originalIndex, index) => originalIndex === index)) {
    return { xData, yDataMap };
  }

  const sortedXData = indices.map((i) => xData[i]);
  const sortedYDataMap: Record<string, (string | number)[]> = {
    ...yDataMap,
  };
  for (const key of yFields) {
    const original = yDataMap[key];
    sortedYDataMap[key] = indices.map((i) => original[i]);
  }

  return { xData: sortedXData, yDataMap: sortedYDataMap };
}
