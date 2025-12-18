import { ArrowClient } from "@/js";
import type { Table } from "apache-arrow";
import { DATE_FIELD_PATTERNS, NAME_FIELD_PATTERNS } from "./constants";
import type {
  ChartData,
  NormalizedChartData,
  NormalizedChartDataBase,
  Orientation,
} from "./types";
import { isArrowTable } from "./types";
import { sortTimeSeriesAscending, toChartArray } from "./utils";

// ============================================================================
// Type Detection Helpers
// ============================================================================

/**
 * Checks if a value looks like an ISO date string
 */
function isDateString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(value);
}

/**
 * Checks if a value is numeric (number or numeric string)
 */
function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (typeof value === "bigint") return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || isDateString(trimmed)) return false;
    const parsed = Number(trimmed);
    return !Number.isNaN(parsed) && Number.isFinite(parsed);
  }
  return false;
}

/**
 * Checks if a value looks like a category/label (non-numeric string)
 */
function isCategoryValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) || !Number.isFinite(parsed);
}

// ============================================================================
// Field Detection
// ============================================================================

/**
 * Detects fields from JSON data for charting
 */
function detectFieldsFromJson(
  data: Record<string, unknown>[],
  orientation?: Orientation,
): {
  xField: string;
  yFields: string[];
  chartType: "timeseries" | "categorical";
} {
  if (!data || data.length === 0) {
    return { xField: "x", yFields: ["y"], chartType: "categorical" };
  }

  const firstRow = data[0];
  const keys = Object.keys(firstRow);

  // Detect date fields by key name OR by value being a date string
  const dateFields = keys.filter((key) => {
    const value = firstRow[key];
    const keyMatchesDatePattern = DATE_FIELD_PATTERNS.some((p) =>
      key.toLowerCase().includes(p),
    );
    const valueIsDateString = isDateString(value);
    return keyMatchesDatePattern || valueIsDateString;
  });

  // Detect name/category fields by pattern AND value type
  let nameFields = keys.filter((key) => {
    const value = firstRow[key];
    return (
      isCategoryValue(value) &&
      !isDateString(value) &&
      NAME_FIELD_PATTERNS.some((p) => key.toLowerCase().includes(p))
    );
  });

  // Fallback: any string field that isn't a date or ID
  if (nameFields.length === 0) {
    nameFields = keys.filter((key) => {
      const value = firstRow[key];
      return (
        isCategoryValue(value) &&
        !isDateString(value) &&
        !dateFields.includes(key) &&
        !key.toLowerCase().endsWith("_id")
      );
    });
  }

  // Detect numeric fields
  const numericFields = keys.filter((key) => {
    const value = firstRow[key];
    return isNumericValue(value) && !dateFields.includes(key);
  });

  const isHorizontal = orientation === "horizontal";

  if (isHorizontal || (nameFields.length > 0 && dateFields.length === 0)) {
    const xField = nameFields[0] || dateFields[0] || keys[0];
    const yFields =
      numericFields.length > 0
        ? numericFields
        : keys.filter((k) => k !== xField);
    return { xField, yFields, chartType: "categorical" };
  }

  const xField = dateFields[0] || nameFields[0] || keys[0];
  const yFields =
    numericFields.length > 0 ? numericFields : keys.filter((k) => k !== xField);
  return {
    xField,
    yFields,
    chartType: dateFields.length > 0 ? "timeseries" : "categorical",
  };
}

// ============================================================================
// Value Conversion
// ============================================================================

/**
 * Converts a JSON value to a chart-compatible value.
 */
function jsonValueToChartValue(
  value: unknown,
  isYValue: boolean,
  isDateField: boolean,
): string | number {
  if (value === null || value === undefined) {
    return isYValue ? 0 : "";
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    if (isDateField && isDateString(value)) {
      const timestamp = new Date(value).getTime();
      if (!Number.isNaN(timestamp)) {
        return timestamp;
      }
    }
    if (isYValue) {
      const trimmed = value.trim();
      const parsed = Number(trimmed);
      if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return value;
  }
  return String(value);
}

// ============================================================================
// Data Extraction
// ============================================================================

/**
 * Extracts chart data from JSON array
 */
function extractFromJson(
  data: Record<string, unknown>[],
  xField: string,
  yFields: string[],
): {
  xData: (string | number)[];
  yDataMap: Record<string, (string | number)[]>;
} {
  const xData: (string | number)[] = [];
  const yDataMap: Record<string, (string | number)[]> = {};

  for (const field of yFields) {
    yDataMap[field] = [];
  }

  const xIsDateField = data.length > 0 && isDateString(data[0][xField]);

  for (const row of data) {
    xData.push(jsonValueToChartValue(row[xField], false, xIsDateField));
    for (const field of yFields) {
      yDataMap[field].push(jsonValueToChartValue(row[field], true, false));
    }
  }

  return { xData, yDataMap };
}

// ============================================================================
// Main Normalization Function
// ============================================================================

/**
 * Normalizes chart data from either Arrow or JSON format.
 * Converts BigInt and Date values to chart-compatible types.
 */
export function normalizeChartData(
  data: ChartData,
  xKey?: string,
  yKey?: string | string[],
  orientation?: Orientation,
): NormalizedChartData {
  if (isArrowTable(data)) {
    const table = data as Table;
    const detected = ArrowClient.detectFieldsFromArrow(table, orientation);
    const resolvedXKey = xKey ?? detected.xField;
    const resolvedYKeys = yKey
      ? Array.isArray(yKey)
        ? yKey
        : [yKey]
      : detected.yFields;

    const { xData: rawXData, yDataMap: rawYDataMap } =
      ArrowClient.extractChartData(table, resolvedXKey, resolvedYKeys);

    let xData = toChartArray(rawXData);
    let yDataMap: Record<string, (string | number)[]> = {};
    for (const key of resolvedYKeys) {
      yDataMap[key] = toChartArray(rawYDataMap[key] ?? []);
    }

    if (detected.chartType === "timeseries") {
      ({ xData, yDataMap } = sortTimeSeriesAscending(
        xData,
        yDataMap,
        resolvedYKeys,
      ));
    }

    return {
      xData,
      yDataMap,
      xField: resolvedXKey,
      yFields: resolvedYKeys,
      chartType: detected.chartType,
    };
  }

  // JSON Array
  const jsonData = data as Record<string, unknown>[];
  const detected = detectFieldsFromJson(jsonData, orientation);
  const resolvedXKey = xKey ?? detected.xField;
  const resolvedYKeys = yKey
    ? Array.isArray(yKey)
      ? yKey
      : [yKey]
    : detected.yFields;

  const { xData: rawXData, yDataMap: rawYDataMap } = extractFromJson(
    jsonData,
    resolvedXKey,
    resolvedYKeys,
  );

  let xData = toChartArray(rawXData);
  let yDataMap: Record<string, (string | number)[]> = {};
  for (const key of resolvedYKeys) {
    yDataMap[key] = toChartArray(rawYDataMap[key] ?? []);
  }

  if (detected.chartType === "timeseries") {
    ({ xData, yDataMap } = sortTimeSeriesAscending(
      xData,
      yDataMap,
      resolvedYKeys,
    ));
  }

  return {
    xData,
    yDataMap,
    xField: resolvedXKey,
    yFields: resolvedYKeys,
    chartType: detected.chartType,
  };
}

// ============================================================================
// Heatmap Data Normalization
// ============================================================================

/**
 * Normalized data for heatmap charts.
 * Extends base (not NormalizedChartData) because heatmaps don't use yDataMap.
 * Instead, they use heatmapData which contains [xIndex, yIndex, value] tuples.
 */
export interface NormalizedHeatmapData extends NormalizedChartDataBase {
  /** Y-axis categories (rows) */
  yAxisData: (string | number)[];
  /** Heatmap data as [xIndex, yIndex, value] tuples */
  heatmapData: [number, number, number][];
  /** Min value in the data */
  min: number;
  /** Max value in the data */
  max: number;
}

/**
 * Normalizes data specifically for heatmap charts.
 * Expects data in format: `{ xKey: string, yAxisKey: string, valueKey: number }`
 *
 * @param data - Raw data (Arrow Table or JSON array)
 * @param xKey - Field key for X-axis (columns)
 * @param yAxisKey - Field key for Y-axis (rows)
 * @param valueKey - Field key for the cell values
 */
export function normalizeHeatmapData(
  data: ChartData,
  xKey?: string,
  yAxisKey?: string,
  valueKey?: string | string[],
): NormalizedHeatmapData {
  // First, get the standard normalization
  const jsonData = isArrowTable(data)
    ? extractJsonFromArrow(data)
    : (data as Record<string, unknown>[]);

  if (jsonData.length === 0) {
    return {
      xData: [],
      xField: xKey ?? "x",
      yFields: [],
      chartType: "categorical",
      yAxisData: [],
      heatmapData: [],
      min: 0,
      max: 0,
    };
  }

  // Detect fields if not provided
  const keys = Object.keys(jsonData[0]);
  const resolvedXKey = xKey ?? keys[0];
  const resolvedYAxisKey = yAxisKey ?? keys[1];
  const resolvedValueKey = valueKey
    ? Array.isArray(valueKey)
      ? valueKey[0]
      : valueKey
    : keys[2];

  // Extract unique X and Y categories
  const xSet = new Set<string | number>();
  const ySet = new Set<string | number>();

  for (const row of jsonData) {
    const xVal = jsonValueToChartValue(row[resolvedXKey], false, false);
    const yVal = jsonValueToChartValue(row[resolvedYAxisKey], false, false);
    xSet.add(xVal);
    ySet.add(yVal);
  }

  const xData = Array.from(xSet);
  const yAxisData = Array.from(ySet);

  // Create index maps for fast lookup
  const xIndexMap = new Map<string | number, number>();
  const yIndexMap = new Map<string | number, number>();
  xData.forEach((v, i) => {
    xIndexMap.set(v, i);
  });
  yAxisData.forEach((v, i) => {
    yIndexMap.set(v, i);
  });

  // Build heatmap data and track min/max
  const heatmapData: [number, number, number][] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const row of jsonData) {
    const xVal = jsonValueToChartValue(row[resolvedXKey], false, false);
    const yVal = jsonValueToChartValue(row[resolvedYAxisKey], false, false);
    const value = jsonValueToChartValue(row[resolvedValueKey], true, false);

    const xIdx = xIndexMap.get(xVal);
    const yIdx = yIndexMap.get(yVal);
    const numValue = typeof value === "number" ? value : 0;

    if (xIdx !== undefined && yIdx !== undefined) {
      heatmapData.push([xIdx, yIdx, numValue]);
      min = Math.min(min, numValue);
      max = Math.max(max, numValue);
    }
  }

  // Handle edge case where no valid data was found
  if (heatmapData.length === 0) {
    min = 0;
    max = 0;
  }

  return {
    xData,
    xField: resolvedXKey,
    yFields: [resolvedValueKey],
    chartType: "categorical",
    yAxisData,
    heatmapData,
    min,
    max,
  };
}

/**
 * Helper to extract JSON array from Arrow table for heatmap processing.
 */
function extractJsonFromArrow(table: Table): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const fields = table.schema.fields.map((f) => f.name);

  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const field of fields) {
      const col = table.getChild(field);
      row[field] = col?.get(i);
    }
    result.push(row);
  }

  return result;
}
