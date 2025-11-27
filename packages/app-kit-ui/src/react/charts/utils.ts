import type { ChartConfig } from "./ui/chart";

/** Field patterns to detect date fields */
const DATE_FIELD_PATTERNS = ["date", "time", "period", "timestamp"];
/** Field patterns to detect name fields */
const NAME_FIELD_PATTERNS = [
  "name",
  "label",
  "app",
  "user",
  "creator",
  "browser",
  "category",
];

/** Chart colors */
const CHART_COLORS = [
  "hsl(160, 84%, 39%)",
  "hsl(220, 70%, 50%)",
  "hsl(280, 65%, 60%)",
  "hsl(25, 95%, 53%)",
  "hsl(340, 75%, 55%)",
];

/** Fields detected from data structure */
export interface DetectedFields {
  /** X field */
  xField: string;
  /** Y fields */
  yFields: string[];
}

/**
 * Automatically detect which fields to use for chart axes
 * @param data - Array of data objects to analyze
 * @param orientation - Chart orientation
 * @returns - Object containing the detected fields
 * @example
 * const data = [
 *   { date: "2024-01-01", revenue: 1000, cost: 500 },
 *   { date: "2024-01-02", revenue: 1200, cost: 600 }
 * ];
 * detectFields(data)
 * { xField: "date", yFields: ["revenue", "cost"] }
 */
export function detectFields(
  data: Array<Record<string, any>>,
  orientation?: "vertical" | "horizontal",
): DetectedFields {
  if (!data || data.length === 0) {
    return { xField: "x", yFields: ["y"] };
  }

  const firstRow = data[0];
  const keys = Object.keys(firstRow);

  // detect date fields
  const dateFields = keys.filter((key) =>
    DATE_FIELD_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern)),
  );

  // detect name fields
  let nameFields = keys.filter((key) => {
    const value = firstRow[key];
    return (
      typeof value === "string" &&
      NAME_FIELD_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern))
    );
  });

  // fallback: if no pattern matches, use any string field that isn't a date
  if (nameFields.length === 0) {
    nameFields = keys.filter((key) => {
      const value = firstRow[key];
      return (
        typeof value === "string" &&
        !dateFields.includes(key) &&
        !key.toLowerCase().endsWith("_id")
      );
    });
  }

  // detect numeric fields
  const numericFields = keys.filter((key) => {
    const value = firstRow[key];
    return typeof value === "number";
  });

  if (orientation === "horizontal") {
    // if horizontal, x is name field, y is numeric field
    const xField = nameFields[0] || dateFields[0] || keys[0];
    const yFields =
      numericFields.length > 0
        ? numericFields
        : keys.filter((k) => k !== xField);
    return { xField, yFields };
  }

  // if vertical, x is date field, y is name field
  const xField = dateFields[0] || nameFields[0] || keys[0];
  const yFields =
    numericFields.length > 0 ? numericFields : keys.filter((k) => k !== xField);
  return { xField, yFields };
}

/**
 * Generates chart configuration with colors and labels
 * @param fields - Array of field names to configure
 * @returns ChartConfig object with colors and labels for each field
 * @example
 * generateChartConfig(["revenue", "cost"])
 * {
 *   revenue: { label: "Revenue", color: "hsl(160, 84%, 39%)" },
 *   cost: { label: "Cost", color: "hsl(220, 70%, 50%)" }
 * }
 */
export function generateChartConfig(fields: string[]): ChartConfig {
  const config: ChartConfig = {};

  fields.forEach((field, index) => {
    config[field] = {
      label: formatFieldLabel(field),
      color: CHART_COLORS[index % CHART_COLORS.length],
    };
  });

  return config;
}

/**
 * Formats numeric values based on field name context
 * @param value - The numeric value to format
 * @param fieldName - The field name to determine formatting
 * @returns Formatted string representation
 * @example
 * formatChartValue(1234.56, "cost") // "$1,234.56"
 * formatChartValue(5000, "users") // "5.0k"
 * formatChartValue(42.7, "percentage") // "42.7"
 */
export function formatChartValue(value: number, fieldName: string): string {
  if (
    fieldName.toLowerCase().includes("cost") ||
    fieldName.toLowerCase().includes("price") ||
    fieldName.toLowerCase().includes("spend") ||
    fieldName.toLowerCase().includes("revenue") ||
    fieldName.toLowerCase().includes("usd")
  ) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  if (value >= 1000) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }

  return value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
}

/**
 * Converts field names to human-readable labels
 * @param field - Field name in camelCase or snake_case
 * @returns Formatted label with proper capitalization
 * @example
 * formatFieldLabel("totalCost") // "Total Cost"
 * formatFieldLabel("user_name") // "User Name"
 * formatFieldLabel("revenue") // "Revenue"
 */
export function formatFieldLabel(field: string): string {
  const safe = field.replace(/[<>"'&]/g, "");
  return safe
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .trim();
}

/**
 * Formats X-axis tick values for display
 * @param value - The tick value
 * @param isHorizontal - Whether the chart is horizontal
 * @returns Formatted tick label
 *
 * @example
 * formatXAxisTick("2024-01-15T00:00:00", false) // "Jan 15"
 * formatXAxisTick(1000, true) // "1.0k"
 er
 * formatXAxisTick("Category A", false) // "Category A"
 */
export const formatXAxisTick = (value: any, isHorizontal: boolean) => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  if (isHorizontal && typeof value === "number") {
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return value.toString();
  }
  return value;
};
