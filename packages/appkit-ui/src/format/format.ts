import type { ColumnMetadata, FormatSpec } from "./types";

/**
 * Library-agnostic format utilities for UC Metric View consumption.
 *
 * Phase 5 of the analytics-metric-view PRD: customers wire metric metadata
 * into Plotly / ECharts / table cells / KPI tiles via these three helpers.
 * No chart-library lock-in, no AppKit-specific chart prop — the utilities
 * accept the YAML 1.1 format spec verbatim and produce strings the consumer
 * passes into their chart of choice.
 *
 * Design decisions:
 *  - **Format-string passthrough.** UC YAML emits printf-style strings; we
 *    forward them. We do NOT design our own format DSL. Consumers see exactly
 *    what their data engineers wrote in the metric view spec.
 *  - **Tolerant fallbacks.** Unrecognized format strings fall back to
 *    sensible defaults (`Intl.NumberFormat` for `formatValue`, identity for
 *    `toD3Format`) rather than throwing. Charts continue to render even when
 *    the metric view's format spec uses an unsupported pattern.
 *  - **No `d3-format` dependency.** `toD3Format` is a pure string conversion
 *    — d3-format itself is the consumer (Plotly's tickformat, ECharts'
 *    valueFormatter, etc.).
 *  - **No null/undefined surprises.** All three helpers handle nullish
 *    inputs gracefully so chart code can pass values straight through
 *    without pre-checking.
 */

/**
 * Format a raw value into a display string per a YAML 1.1 format spec.
 *
 * When `format` is provided and recognized:
 *  - `$#,##0.00` style → currency (`"$1,234.56"`)
 *  - `#,##0.00` / `0.000` style → fixed-precision number (`"1,234.57"`)
 *  - `0.0%` / `#,##0%` style → percentage (`"42.7%"`)
 *  - `#,##0` style → integer with thousands separator (`"1,234"`)
 *
 * When `format` is unset / unrecognized / unparseable, falls back to:
 *  - localized number formatting via `Intl.NumberFormat` for numeric values
 *  - `String(value)` for non-numeric values
 *
 * Null / undefined input always returns the empty string — chart code can
 * pass row cells straight through without pre-checking.
 *
 * @example
 * formatValue(1234.56, "$#,##0.00") // "$1,234.56"
 * formatValue(0.427, "0.0%")        // "42.7%"
 * formatValue(1234, "#,##0")        // "1,234"
 * formatValue(42, undefined)        // "42"
 * formatValue("EMEA", undefined)    // "EMEA"
 * formatValue(null, "$#,##0.00")    // ""
 */
export function formatValue(value: unknown, format?: FormatSpec): string {
  if (value == null) return "";

  // Non-numeric values are returned as their string form regardless of format
  // spec — the spec only makes sense for numeric output and the printf style
  // does not have a defined meaning over strings/booleans/dates.
  if (typeof value !== "number" && typeof value !== "bigint") {
    return String(value);
  }

  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return String(numeric);

  const parsed = format ? parseFormatSpec(format) : null;
  if (parsed == null) {
    // No format / unrecognized format → localized number formatting. Using
    // the user's locale (no explicit "en-US") so numbers render correctly in
    // EU/JP/etc apps without the customer wiring locale plumbing.
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 6,
    }).format(numeric);
  }

  const { kind, fractionDigits, useGrouping, currencyPrefix, currencySuffix } =
    parsed;

  switch (kind) {
    case "percent":
      return new Intl.NumberFormat(undefined, {
        style: "percent",
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
        useGrouping,
      }).format(numeric);
    case "currency": {
      // We emit the currency symbol verbatim from the format spec rather than
      // relying on `Intl.NumberFormat({ style: "currency", currency: "USD" })`
      // — the YAML's `$#,##0.00` does not specify ISO currency code, and
      // assuming USD would be wrong for non-US deployments. Passthrough lets
      // data engineers pin the symbol they intend.
      const numberPart = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
        useGrouping,
      }).format(Math.abs(numeric));
      const sign = numeric < 0 ? "-" : "";
      return `${sign}${currencyPrefix ?? ""}${numberPart}${currencySuffix ?? ""}`;
    }
    case "number":
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
        useGrouping,
      }).format(numeric);
  }
}

/**
 * Render a column's display label.
 *
 * Returns `display_name` from the metadata when present (the YAML 1.1
 * canonical label). When metadata is absent or `display_name` is missing,
 * humanizes the column name:
 *  - snake_case (`total_revenue`) → "Total Revenue"
 *  - camelCase (`customerCount`) → "Customer Count"
 *  - PascalCase (`UserId`) → "User Id"
 *  - SCREAMING_SNAKE (`USER_ID`) → "User Id"
 *  - already-spaced (`Annual Recurring Revenue`) → unchanged (title-case)
 *
 * @example
 * formatLabel("arr", { type: "DECIMAL", display_name: "Annual Recurring Revenue" })
 *   // "Annual Recurring Revenue"
 * formatLabel("total_revenue") // "Total Revenue"
 * formatLabel("customerCount") // "Customer Count"
 * formatLabel("revenue")       // "Revenue"
 */
export function formatLabel(
  name: string,
  columnMetadata?: ColumnMetadata,
): string {
  if (
    columnMetadata?.display_name &&
    columnMetadata.display_name.trim().length > 0
  ) {
    return columnMetadata.display_name;
  }
  return humanizeIdentifier(name);
}

/**
 * Convert a UC YAML 1.1 printf-style format spec to a d3-format-compatible
 * string. The output is consumed by Plotly's `tickformat`, ECharts'
 * `valueFormatter`, table cell formatters, and any other library that
 * understands d3-format syntax.
 *
 * Conversions:
 *  - `$#,##0.00` → `"$,.2f"`
 *  - `0.00%`     → `".2%"`
 *  - `#,##0`     → `",.0f"`
 *  - `0.000`     → `".3f"`
 *
 * Unrecognized specs fall back to identity (the input string) so the chart
 * library either consumes it directly (if it happens to be d3-format already)
 * or surfaces its own warning. Returns the empty string for nullish input
 * (chart libraries treat `""` as "use default").
 *
 * @example
 * toD3Format("$#,##0.00") // "$,.2f"
 * toD3Format("0.0%")      // ".1%"
 * toD3Format("#,##0")     // ",.0f"
 * toD3Format(undefined)   // ""
 */
export function toD3Format(format?: FormatSpec): string {
  if (!format) return "";
  const parsed = parseFormatSpec(format);
  if (parsed == null) {
    // Unrecognized → identity. The consumer's chart library decides whether
    // to consume it (e.g. Plotly silently ignores invalid tickformats) or to
    // surface its own warning. We don't throw because chart libraries
    // typically can't propagate exceptions out of their render path.
    return format;
  }

  const groupPart = parsed.useGrouping ? "," : "";
  switch (parsed.kind) {
    case "currency":
      // d3-format's `$` prefix is the standard "use locale's currency
      // symbol" — most Plotly users want the YAML's literal symbol though.
      // We emit `$` here so existing d3-format docs match; consumers that
      // need a non-USD symbol pass `format` directly into their chart.
      return `$${groupPart}.${parsed.fractionDigits}f`;
    case "percent":
      return `${groupPart}.${parsed.fractionDigits}%`;
    case "number":
      return `${groupPart}.${parsed.fractionDigits}f`;
  }
}

/**
 * Parsed shape of a printf-style format spec. The parser is intentionally
 * narrow: it recognizes the shapes UC documents (`$#,##0.00`, `0.0%`,
 * `#,##0`, `0.000`, etc.) and returns null for anything else so callers can
 * fall back to a sensible default.
 *
 * @internal
 */
interface ParsedFormat {
  kind: "currency" | "percent" | "number";
  fractionDigits: number;
  useGrouping: boolean;
  /** Currency prefix (e.g. `"$"`, `"€"`) when the format starts with a symbol. */
  currencyPrefix?: string;
  /** Currency suffix (e.g. `" kr"`) when the format ends with a non-digit token. */
  currencySuffix?: string;
}

/**
 * Recognize the small grammar of printf-style format specs we forward.
 *
 * Approach: strip percent / currency markers, count fractional digits via
 * the substring after `.`, detect grouping via the presence of `,`. Anything
 * not matching the recognized shape returns null.
 */
function parseFormatSpec(spec: FormatSpec): ParsedFormat | null {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return null;

  // Percent forms: `0.00%`, `#,##0%`, `0.0%`, `0%`.
  const percentMatch = trimmed.match(/^([#,]*[0]+(?:\.[0]+)?)\s*%$/);
  if (percentMatch) {
    const numericPart = percentMatch[1];
    return {
      kind: "percent",
      fractionDigits: countFractionDigits(numericPart),
      useGrouping: numericPart.includes(","),
    };
  }

  // Currency forms: `$#,##0.00`, `€#,##0`, `$0.000`. Currency prefix is one
  // or more leading non-digit/non-`#`/non-`,`/non-`.` characters, followed by
  // the numeric portion.
  const currencyPrefixMatch = trimmed.match(/^([^#,0.]+)([#,0.]+)$/);
  if (currencyPrefixMatch) {
    const prefix = currencyPrefixMatch[1];
    const numericPart = currencyPrefixMatch[2];
    if (isNumericFormat(numericPart)) {
      return {
        kind: "currency",
        fractionDigits: countFractionDigits(numericPart),
        useGrouping: numericPart.includes(","),
        currencyPrefix: prefix,
      };
    }
  }

  // Suffix-symbol currency: `#,##0.00 kr`, `0.00 €`. Numeric portion first,
  // suffix second (separated by a space or directly adjacent).
  const currencySuffixMatch = trimmed.match(/^([#,0.]+)(\s*[^#,0.]+)$/);
  if (currencySuffixMatch) {
    const numericPart = currencySuffixMatch[1];
    const suffix = currencySuffixMatch[2];
    if (isNumericFormat(numericPart)) {
      return {
        kind: "currency",
        fractionDigits: countFractionDigits(numericPart),
        useGrouping: numericPart.includes(","),
        currencySuffix: suffix,
      };
    }
  }

  // Plain number forms: `#,##0`, `#,##0.00`, `0.000`, `0`.
  if (isNumericFormat(trimmed)) {
    return {
      kind: "number",
      fractionDigits: countFractionDigits(trimmed),
      useGrouping: trimmed.includes(","),
    };
  }

  return null;
}

/**
 * Whether a string is a printf-numeric pattern of `#`, `0`, `,`, and `.`.
 * A valid pattern has at least one digit placeholder (`0` or `#`).
 */
function isNumericFormat(s: string): boolean {
  if (!/^[#,0.]+$/.test(s)) return false;
  return /[0#]/.test(s);
}

/** Count the number of `0` or `#` placeholders after the decimal point. */
function countFractionDigits(s: string): number {
  const dotIdx = s.indexOf(".");
  if (dotIdx === -1) return 0;
  const fractional = s.slice(dotIdx + 1);
  // Fractional part should be all `0` and `#` after the decimal — count the
  // total digit-placeholder count to determine fraction width.
  return (fractional.match(/[0#]/g) ?? []).length;
}

/**
 * Humanize a column identifier into a Title-Case display string.
 *
 * Handles snake_case, camelCase, PascalCase, SCREAMING_SNAKE_CASE, and
 * already-spaced inputs. Sanitizes non-identifier characters (the same
 * pattern as the existing `formatFieldLabel`'s safe-key regex) so user-
 * supplied names cannot inject markup.
 */
function humanizeIdentifier(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_\- ]/g, "");
  if (safe.length === 0) return "";

  // Insert a space before capitals (camelCase / PascalCase boundaries),
  // replace `_` and `-` with spaces, collapse runs, then title-case each word.
  const withSpaces = safe
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (withSpaces.length === 0) return "";

  return withSpaces
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
