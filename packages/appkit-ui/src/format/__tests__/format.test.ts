import { describe, expect, test } from "vitest";
import { formatLabel, formatValue, toD3Format } from "../format";

/**
 * Format utility tests for Phase 5 of the metric-view PRD.
 *
 * Coverage matrix per the task acceptance criteria:
 *  - formatValue: currency / percent / number / unknown-fallback / null cases
 *  - formatLabel: camelCase / snake_case / display-name-override
 *  - toD3Format: currency / percent / integer / unknown-fallback
 */

describe("formatValue", () => {
  test("formats currency with two decimals", () => {
    expect(formatValue(1234.56, "$#,##0.00")).toBe("$1,234.56");
  });

  test("formats currency with thousands separator", () => {
    expect(formatValue(1234567.89, "$#,##0.00")).toBe("$1,234,567.89");
  });

  test("formats negative currency with sign before symbol", () => {
    expect(formatValue(-1234.56, "$#,##0.00")).toBe("-$1,234.56");
  });

  test("formats zero currency correctly", () => {
    expect(formatValue(0, "$#,##0.00")).toBe("$0.00");
  });

  test("formats percent with one decimal", () => {
    expect(formatValue(0.427, "0.0%")).toBe("42.7%");
  });

  test("formats percent with no decimals", () => {
    expect(formatValue(0.5, "0%")).toBe("50%");
  });

  test("formats percent with two decimals", () => {
    expect(formatValue(0.12345, "0.00%")).toBe("12.35%");
  });

  test("formats integer with thousands separator", () => {
    expect(formatValue(1234, "#,##0")).toBe("1,234");
  });

  test("formats fixed-precision number", () => {
    expect(formatValue(1.23456, "0.000")).toBe("1.235");
  });

  test("formats number without grouping when format omits comma", () => {
    expect(formatValue(1234, "0")).toBe("1234");
  });

  test("falls back to localized formatting for unrecognized format spec", () => {
    // Unknown spec → Intl.NumberFormat default. Just assert it's a non-empty
    // string that contains the digits — locale-specific separators vary.
    const result = formatValue(1234.5, "weird-spec-xyz");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("falls back to localized formatting when format is undefined", () => {
    const result = formatValue(42);
    expect(typeof result).toBe("string");
    expect(result).toContain("42");
  });

  test("returns empty string for null value", () => {
    expect(formatValue(null, "$#,##0.00")).toBe("");
  });

  test("returns empty string for undefined value", () => {
    expect(formatValue(undefined, "$#,##0.00")).toBe("");
  });

  test("returns String(value) for string input regardless of format", () => {
    expect(formatValue("EMEA", "$#,##0.00")).toBe("EMEA");
  });

  test("returns String(value) for boolean input", () => {
    expect(formatValue(true)).toBe("true");
  });

  test("handles bigint input by converting to number", () => {
    expect(formatValue(1234n, "#,##0")).toBe("1,234");
  });

  test("returns String(NaN) when value is non-finite", () => {
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });

  test("recognizes suffix-style currency (e.g. 0.00 kr)", () => {
    // Common Nordic format
    expect(formatValue(1234.56, "#,##0.00 kr")).toContain("1,234.56");
    expect(formatValue(1234.56, "#,##0.00 kr")).toContain("kr");
  });
});

describe("formatLabel", () => {
  test("returns display_name from metadata when present", () => {
    expect(
      formatLabel("arr", {
        type: "DECIMAL",
        display_name: "Annual Recurring Revenue",
      }),
    ).toBe("Annual Recurring Revenue");
  });

  test("falls back to humanization when display_name is absent", () => {
    expect(formatLabel("arr", { type: "DECIMAL" })).toBe("Arr");
  });

  test("falls back to humanization when metadata is undefined", () => {
    expect(formatLabel("revenue")).toBe("Revenue");
  });

  test("humanizes snake_case", () => {
    expect(formatLabel("total_revenue")).toBe("Total Revenue");
    expect(formatLabel("user_name")).toBe("User Name");
    expect(formatLabel("annual_recurring_revenue")).toBe(
      "Annual Recurring Revenue",
    );
  });

  test("humanizes camelCase", () => {
    expect(formatLabel("customerCount")).toBe("Customer Count");
    expect(formatLabel("totalCost")).toBe("Total Cost");
    expect(formatLabel("annualRecurringRevenue")).toBe(
      "Annual Recurring Revenue",
    );
  });

  test("humanizes PascalCase", () => {
    expect(formatLabel("UserId")).toBe("User Id");
    expect(formatLabel("CustomerCount")).toBe("Customer Count");
  });

  test("humanizes SCREAMING_SNAKE_CASE", () => {
    expect(formatLabel("USER_ID")).toBe("User Id");
    expect(formatLabel("ANNUAL_REVENUE")).toBe("Annual Revenue");
  });

  test("preserves already-spaced input with title-case normalization", () => {
    expect(formatLabel("annual revenue")).toBe("Annual Revenue");
  });

  test("ignores empty/whitespace display_name and falls back to humanization", () => {
    expect(formatLabel("arr", { type: "DECIMAL", display_name: "   " })).toBe(
      "Arr",
    );
    expect(formatLabel("arr", { type: "DECIMAL", display_name: "" })).toBe(
      "Arr",
    );
  });

  test("strips dangerous non-identifier characters before humanizing", () => {
    expect(formatLabel("user<script>name</script>")).toBe(
      "Userscriptnamescript",
    );
  });

  test("returns empty string for an empty input name", () => {
    expect(formatLabel("")).toBe("");
  });

  test("handles single-word lowercase identifier", () => {
    expect(formatLabel("revenue")).toBe("Revenue");
  });

  test("handles consecutive capitals (acronyms)", () => {
    expect(formatLabel("ARRGrowth")).toBe("Arr Growth");
  });
});

describe("toD3Format", () => {
  test("converts currency with two decimals", () => {
    expect(toD3Format("$#,##0.00")).toBe("$,.2f");
  });

  test("converts currency with no decimals", () => {
    expect(toD3Format("$#,##0")).toBe("$,.0f");
  });

  test("converts percent with one decimal", () => {
    expect(toD3Format("0.0%")).toBe(".1%");
  });

  test("converts percent with two decimals", () => {
    expect(toD3Format("0.00%")).toBe(".2%");
  });

  test("converts percent with thousands separator", () => {
    expect(toD3Format("#,##0.0%")).toBe(",.1%");
  });

  test("converts integer with thousands separator", () => {
    expect(toD3Format("#,##0")).toBe(",.0f");
  });

  test("converts integer without thousands separator", () => {
    expect(toD3Format("0")).toBe(".0f");
  });

  test("converts fixed-precision number", () => {
    expect(toD3Format("0.000")).toBe(".3f");
  });

  test("falls back to identity for unrecognized format spec", () => {
    expect(toD3Format("weird-spec-xyz")).toBe("weird-spec-xyz");
  });

  test("returns empty string for undefined format", () => {
    expect(toD3Format()).toBe("");
  });

  test("returns empty string for empty format", () => {
    expect(toD3Format("")).toBe("");
  });

  test("treats already-d3 format as identity (acceptable: chart consumes it)", () => {
    expect(toD3Format(".2f")).toBe(".2f");
  });
});

// ── End-to-end utility flow: simulating chart consumption ────────────────
describe("library-agnostic chart consumption flow", () => {
  test("Plotly tickformat workflow: metadata → toD3Format → tickformat string", () => {
    // Customer would do: { tickformat: toD3Format(metadata.measures.arr.format) }
    const metadataFormat = "$#,##0.00";
    const tickformat = toD3Format(metadataFormat);
    expect(tickformat).toBe("$,.2f");
  });

  test("ECharts valueFormatter workflow: format function from metadata", () => {
    const metadata = {
      type: "DECIMAL",
      display_name: "ARR",
      format: "$#,##0.00",
    };
    // ECharts valueFormatter receives raw values and returns strings.
    const valueFormatter = (v: number) => formatValue(v, metadata.format);
    expect(valueFormatter(1234.56)).toBe("$1,234.56");
  });

  test("Table cell workflow: formatValue per row, formatLabel per column", () => {
    const arrMetadata: import("../types").ColumnMetadata = {
      type: "DECIMAL",
      display_name: "Annual Recurring Revenue",
      format: "$#,##0.00",
    };
    const regionMetadata: import("../types").ColumnMetadata = {
      type: "STRING",
    };

    expect(formatLabel("arr", arrMetadata)).toBe("Annual Recurring Revenue");
    expect(formatLabel("region", regionMetadata)).toBe("Region");
    expect(formatValue(1234.56, arrMetadata.format)).toBe("$1,234.56");
    // No format spec on the dimension; passes through value as-is.
    expect(formatValue("EMEA", regionMetadata.format)).toBe("EMEA");
  });

  test("KPI tile workflow: scalar value with optional unknown format", () => {
    // Customer KPI tile is a single value display.
    expect(formatValue(0.427, "0.0%")).toBe("42.7%");
    // Falls back gracefully when the metric YAML lacks a format spec.
    expect(formatValue(0.427)).toBeTruthy();
  });
});
