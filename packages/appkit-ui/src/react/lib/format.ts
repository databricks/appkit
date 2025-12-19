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
  const safe = field.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .trim();
}

/** Regex for validating field names */
export const SAFE_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
