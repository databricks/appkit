import type { MetricViewColumnDisplay } from "shared";

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
 * The currency symbol a spec carries — everything before the first digit
 * placeholder (`#`/`0`). The metric-view generator emits `$`, `€`, `£`, `¥`,
 * `₹`, `R$`, or an unknown ISO code + space (e.g. `"XYZ "`); this recovers any
 * of them verbatim. Returns `""` for a bare numeric spec (`"#,##0"`) or a
 * percent spec (`"0.0%"`), neither of which has a leading symbol.
 */
function currencyPrefix(format: string): string {
  const match = format.match(/^[^#0]+/);
  return match ? match[0] : "";
}

/**
 * Format a raw value using a UC/YAML printf-style format spec.
 *
 * Recognizes the common spreadsheet-style specs:
 * - currency prefix, e.g. `"$#,##0.00"` (1234.5 -> "$1,234.50"); the prefix is
 *   emitted verbatim, so `"€#,##0"`, `"R$#,##0.00"`, etc. survive end-to-end
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

  const isPercent = format.includes("%");
  const grouping = format.includes(",");
  const decimals = countDecimals(format);
  const prefix = currencyPrefix(format);

  // bigint fast path. A bigint is an exact integer, so `BigInt.toLocaleString`
  // formats it losslessly — `Number(bigint)` would corrupt values beyond ±2^53
  // (int64 counts / cents). The percent path multiplies by 100 (float math a
  // large bigint can't survive), so refuse it rather than emit a wrong number.
  if (typeof value === "bigint") {
    if (isPercent) return String(value);
    const sign = value < 0n ? "-" : "";
    // `Intl.NumberFormat` accepts a bigint directly and formats it exactly (no
    // float coercion), unlike `Number(value)`.
    const body = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    }).format(value < 0n ? -value : value);
    return `${sign}${prefix}${body}`;
  }

  const num = coerceNumber(value);
  // Non-numeric value with a numeric-ish spec: nothing sensible to format.
  if (num === null) return String(value);

  if (isPercent) {
    return `${formatNumber(num * 100, decimals, grouping)}%`;
  }

  if (prefix) {
    const sign = num < 0 ? "-" : "";
    return `${sign}${prefix}${formatNumber(Math.abs(num), decimals, grouping)}`;
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
  columnMeta?: MetricViewColumnDisplay,
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
 * - `"€#,##0.00"` -> `"$,.2f"` (currency), `"#,##0"` -> `",.0f"`, `"0.0%"` -> `".1%"`
 *
 * A d3 specifier's currency marker is the single `$` symbol; the actual glyph
 * ($, €, R$, …) is supplied by the d3 *locale*, not the specifier string — so a
 * non-USD currency spec still maps to the `$` currency type here (it is not
 * rejected as unrecognized), and the caller's d3 locale renders the right glyph.
 *
 * No spec, or a spec that is not a recognizable numeric pattern -> `undefined`.
 */
export function toD3Format(format?: string): string | undefined {
  if (!format) return undefined;

  // Strip any leading currency prefix first, then require the remainder to be
  // built purely from numeric-format characters; anything else (date patterns,
  // free text, ...) is left unrecognized.
  const prefix = currencyPrefix(format);
  const numeric = format.slice(prefix.length);
  if (numeric.replace(/[#0,.%\s]/g, "") !== "") return undefined;
  if (!/[0#]/.test(numeric)) return undefined;

  const group = format.includes(",") ? "," : "";
  const decimals = countDecimals(format);

  if (format.includes("%")) {
    return `${group}.${decimals}%`;
  }

  // `$` is d3's currency marker (glyph comes from the locale); emit it for any
  // currency prefix, USD or otherwise.
  return `${prefix ? "$" : ""}${group}.${decimals}f`;
}
