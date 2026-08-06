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

// `formatLabel` lives canonically on the `/js` axis (it also accepts a
// `MetricViewColumnDisplay` to prefer a `display_name`). Re-export the superset so the
// `/react` surface has a single humanize implementation — a `/react` consumer
// and a `/js` consumer get identical behavior. Chart internals call it with
// just a field name, which the superset handles.
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
 *
 * Internal: `mapToDatum` is not part of the public chart surface (the barrel
 * re-exports only the formatting/sorting helpers), so this stays unexported.
 */
interface DatumAxisContext {
  /** Category labels of the x axis, in index order. */
  xLabels?: (string | number)[];
  /** Category labels of the heatmap's y axis, in index order. */
  yLabels?: (string | number)[];
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
 * Per-series-type value handling — the datum shape differs by series, so this
 * branches on `params.seriesType` rather than inferring from the array's shape:
 * - `heatmap` → data items are `[xIndex, yIndex, value]` **index** triples. The
 *   third entry is the cell value; the first two are positions, resolved back to
 *   their category labels via {@link DatumAxisContext} (falling back to the raw
 *   index when no labels are supplied).
 * - `radar` → the data item's `value` is an array of per-indicator measures with
 *   no single scalar to report, so `value` is `null` and `x`/`y` stay
 *   `undefined`. Read the whole vector from `raw`.
 * - everything else → a scalar datum (bar/pie) passes through, and an `[x, y]`
 *   tuple (time-series / scatter) splits into `x`/`y` with `y` surfaced as
 *   `value`.
 *
 * Remaining fields:
 * - `name` → coerced to a string, falling back to `""` when missing. For a
 *   tuple datum whose name is absent, the x-component's string form is used so
 *   callers still get a meaningful label.
 * - `seriesName` → kept when it is a string, otherwise left `undefined`.
 * - `dataIndex` / `seriesIndex` → kept when numeric, otherwise `-1`.
 * - `raw` → the entire original `params` object, untouched.
 *
 * @param params - The raw ECharts click-event payload (untyped at our boundary).
 * @param axes - Category labels used to resolve index-addressed heatmap data.
 * @returns A normalized, ECharts-free {@link ChartClickDatum}.
 */
export function mapToDatum(
  params: unknown,
  axes: DatumAxisContext = {},
): ChartClickDatum {
  const p = (
    params !== null && typeof params === "object" ? params : {}
  ) as Record<string, unknown>;

  const isScalar = (v: unknown): v is number | string =>
    typeof v === "number" || typeof v === "string";

  const rawValue = p.value;
  const seriesType =
    typeof p.seriesType === "string" ? p.seriesType : undefined;

  let x: number | string | undefined;
  let y: number | string | undefined;
  let value: number | string | null;

  if (seriesType === "heatmap" && Array.isArray(rawValue)) {
    // `[xIndex, yIndex, value]`: report the cell value, and translate the two
    // indices into the category labels the axes display.
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
    // A radar item holds one value per indicator; there is no single scalar to
    // report, and picking an arbitrary component would be a lie.
    value = null;
  } else if (Array.isArray(rawValue)) {
    // `[x, y]` tuple datum (time-series / scatter): split the components out so
    // callers don't have to re-parse `raw`.
    if (isScalar(rawValue[0])) x = rawValue[0];
    if (isScalar(rawValue[1])) y = rawValue[1];
    value = y ?? null;
  } else {
    value = isScalar(rawValue) ? rawValue : null;
  }

  // Prefer the datum's own name; for a tuple point without one, fall back to
  // the x-component's string form (e.g. a timestamp) rather than "".
  const name =
    typeof p.name === "string" ? p.name : x !== undefined ? String(x) : "";

  const seriesName =
    typeof p.seriesName === "string" ? p.seriesName : undefined;

  const dataIndex = typeof p.dataIndex === "number" ? p.dataIndex : -1;
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
