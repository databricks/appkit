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
 * Best-effort coercion of an arbitrary value to a finite number.
 * Returns null when the value cannot be meaningfully treated as a number.
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

/**
 * An integer-shaped string whose magnitude exceeds JS's safe-integer range, as
 * a bigint — otherwise `null`.
 *
 * The JSON_ARRAY wire path delivers every numeric cell as a *string* (the SQL
 * connector copies `data_array` cells verbatim), so a BIGINT / large DECIMAL
 * arrives here as e.g. `"9007199254740993"`. Coercing that through `Number`
 * silently rounds it, so an int64 id or a cents-denominated total renders as a
 * neighbouring value. Detect the case up front and keep it exact.
 */
function asPreciseBigInt(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const asBig = BigInt(trimmed);
  return asBig > BigInt(Number.MAX_SAFE_INTEGER) ||
    asBig < -BigInt(Number.MAX_SAFE_INTEGER)
    ? asBig
    : null;
}

/**
 * Format a bigint exactly, with fixed decimals + optional thousands grouping
 * and a currency prefix inside the sign. `Intl.NumberFormat` accepts a bigint
 * directly and formats it without float coercion, unlike `Number(value)`.
 */
function formatBigInt(
  value: bigint,
  decimals: number,
  grouping: boolean,
  prefix: string,
): string {
  const sign = value < 0n ? "-" : "";
  const body = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  }).format(value < 0n ? -value : value);
  return `${sign}${prefix}${body}`;
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

  // Exact-integer path. A bigint formats losslessly via `Intl.NumberFormat`,
  // whereas `Number(bigint)` corrupts values beyond ±2^53 (int64 counts /
  // cents). Reached both by a genuine bigint and by an oversized integer-shaped
  // *string* off the JSON_ARRAY wire — see `asPreciseBigInt`.
  const big =
    typeof value === "bigint"
      ? value
      : typeof value === "string"
        ? asPreciseBigInt(value)
        : null;
  if (big !== null) {
    // The percent path multiplies by 100 (float math a large bigint can't
    // survive), so refuse it rather than emit a wrong number.
    if (isPercent) return String(big);
    return formatBigInt(big, decimals, grouping, prefix);
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

// Turns a raw column name into a human-readable label.
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

export function formatLabel(
  name: string,
  columnMeta?: MetricViewColumnDisplay,
): string {
  if (columnMeta?.display_name) return columnMeta.display_name;
  return humanize(name);
}

export interface D3FormatParts {
  /** Numeric d3-format specifier, without a currency symbol. */
  specifier: string;
  /** Literal currency prefix from the UC format, when present. */
  prefix?: string;
}

/**
 * Maps a UC/spreadsheet-style format spec to the pieces consumed by
 * [d3-format](https://d3js.org/d3-format)-based charts.
 *
 * Best-effort mapping for the common specs:
 * - `"$#,##0.00"` -> `{ specifier: ",.2f", prefix: "$" }`
 * - `"€#,##0.00"` -> `{ specifier: ",.2f", prefix: "€" }`
 * - `"#,##0"` -> `{ specifier: ",.0f" }`, `"0.0%"` -> `{ specifier: ".1%" }`
 *
 * A d3 specifier cannot encode an arbitrary currency symbol: its `$` marker is
 * resolved through global locale configuration. Returning the literal prefix
 * separately lets consumers such as Plotly pass it as `tickprefix` instead of
 * silently rendering every currency as `$`.
 *
 * No spec, or a spec that is not a recognizable numeric pattern -> `undefined`.
 */
export function toD3Format(format?: string): D3FormatParts | undefined {
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
    return {
      specifier: `${group}.${decimals}%`,
      ...(prefix ? { prefix } : {}),
    };
  }

  return {
    specifier: `${group}.${decimals}f`,
    ...(prefix ? { prefix } : {}),
  };
}
