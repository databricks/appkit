import type { MetricColumnMeta } from "shared";

// ============================================================================
// Pure Format Utilities
// ============================================================================
// Library-agnostic, tree-shakeable helpers for turning raw metric values and
// column metadata into display strings. These take the UC/YAML format spec (or
// MetricColumnMeta) as ARGUMENTS — no React, no chart-lib coupling, no bundled
// artifact — so they can be used from any surface (tables, tooltips, charts).

/**
 * Counts the number of fractional digits declared by a numeric format spec.
 * E.g. "#,##0.00" -> 2, "#,##0" -> 0, "0.0%" -> 1.
 */
function countDecimals(format: string): number {
  const dotIndex = format.indexOf(".");
  if (dotIndex === -1) return 0;
  const frac = format.slice(dotIndex + 1);
  const match = frac.match(/^[0#]+/);
  return match ? match[0].length : 0;
}

/**
 * Best-effort coercion of an arbitrary value to a finite number. Handles the
 * common wire shapes (number, bigint, numeric string). Returns null when the
 * value cannot be meaningfully treated as a number.
 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Format a number with fixed decimals + optional thousands grouping. */
function formatNumber(
  value: number,
  decimals: number,
  grouping: boolean,
): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  });
}

/**
 * Format a raw value using a UC/YAML printf-style format spec.
 *
 * Recognizes the common spreadsheet-style specs:
 * - currency prefix, e.g. `"$#,##0.00"` (1234.5 -> "$1,234.50")
 * - thousands grouping + N decimals, e.g. `"#,##0"` (1234567 -> "1,234,567")
 *   or `"#,##0.00"` (1234.5 -> "1,234.50")
 * - percent, e.g. `"0.0%"` (0.1234 -> "12.3%") — the value is multiplied by 100
 *
 * No format spec -> sensible default: numbers via `toLocaleString`, everything
 * else via `String()`. `null`/`undefined` -> `""`. Unrecognized specs fall back
 * to a best-effort result (the number grouped, or `String(value)`).
 */
export function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined) return "";

  if (!format) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value.toLocaleString() : String(value);
    }
    if (typeof value === "bigint") return value.toLocaleString();
    return String(value);
  }

  const num = coerceNumber(value);
  // Non-numeric value with a numeric-ish spec: nothing sensible to format.
  if (num === null) return String(value);

  const isPercent = format.includes("%");
  const isCurrency = format.includes("$");
  const grouping = format.includes(",");
  const decimals = countDecimals(format);

  if (isPercent) {
    return `${formatNumber(num * 100, decimals, grouping)}%`;
  }

  if (isCurrency) {
    const sign = num < 0 ? "-" : "";
    return `${sign}$${formatNumber(Math.abs(num), decimals, grouping)}`;
  }

  return formatNumber(num, decimals, grouping);
}

/**
 * Turns a raw column name into a human-readable label.
 * Handles camelCase, snake_case, acronyms, and ALL_CAPS.
 * E.g., "totalSpend" -> "Total Spend", "avg_ltv" -> "Avg Ltv".
 */
function humanize(name: string): string {
  return (
    name
      // Handle consecutive uppercase followed by lowercase (e.g., HTTPUrl -> HTTP Url)
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      // Handle lowercase followed by uppercase (e.g., totalSpend -> total Spend)
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
 * Human label for a column: prefers `columnMeta.display_name`, else humanizes
 * the raw column name (camelCase / snake_case / CAPS -> Title Case).
 */
export function formatLabel(
  name: string,
  columnMeta?: MetricColumnMeta,
): string {
  if (columnMeta?.display_name) return columnMeta.display_name;
  return humanize(name);
}

/**
 * Maps a UC/spreadsheet-style format spec to a
 * [d3-format](https://d3js.org/d3-format) specifier string, for charts that
 * consume d3 format strings.
 *
 * Best-effort mapping for the common specs:
 * - `"$#,##0.00"` -> `"$,.2f"`
 * - `"#,##0"`     -> `",.0f"`
 * - `"#,##0.00"`  -> `",.2f"`
 * - `"0.0%"`      -> `".1%"`
 *
 * No spec, or a spec that is not a recognizable numeric pattern -> `undefined`.
 */
export function toD3Format(format?: string): string | undefined {
  if (!format) return undefined;

  // Only map specs built purely from numeric-format characters; anything else
  // (date patterns, free text, ...) is left unrecognized.
  if (format.replace(/[#0,.$%\s]/g, "") !== "") return undefined;
  if (!/[0#]/.test(format)) return undefined;

  const group = format.includes(",") ? "," : "";
  const decimals = countDecimals(format);

  if (format.includes("%")) {
    return `${group}.${decimals}%`;
  }

  const prefix = format.includes("$") ? "$" : "";
  return `${prefix}${group}.${decimals}f`;
}
