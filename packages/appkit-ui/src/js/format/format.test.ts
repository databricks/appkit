import { describe, expect, test } from "vitest";
import { formatLabel, formatValue, toD3Format } from "./format";

describe("js/format formatValue", () => {
  test("currency spec formats with prefix, grouping and 2 decimals", () => {
    expect(formatValue(1234.5, "$#,##0.00")).toBe("$1,234.50");
  });

  test("currency spec handles negatives with sign before the symbol", () => {
    expect(formatValue(-1234.5, "$#,##0.00")).toBe("-$1,234.50");
  });

  test("integer spec groups thousands with no decimals", () => {
    expect(formatValue(1234567, "#,##0")).toBe("1,234,567");
  });

  test("decimal grouping spec keeps N decimals", () => {
    expect(formatValue(1234.5, "#,##0.00")).toBe("1,234.50");
  });

  test("percent spec multiplies by 100 and appends %", () => {
    expect(formatValue(0.1234, "0.0%")).toBe("12.3%");
  });

  test("integer percent spec has no decimals", () => {
    expect(formatValue(0.5, "0%")).toBe("50%");
  });

  test("accepts numeric strings", () => {
    expect(formatValue("1234.5", "$#,##0.00")).toBe("$1,234.50");
  });

  test("accepts bigint values", () => {
    expect(formatValue(1234567n, "#,##0")).toBe("1,234,567");
  });

  test("no format falls back to toLocaleString for numbers", () => {
    expect(formatValue(1234.5)).toBe((1234.5).toLocaleString());
  });

  test("no format passes through strings", () => {
    expect(formatValue("hello")).toBe("hello");
  });

  test("null and undefined become empty string", () => {
    expect(formatValue(null)).toBe("");
    expect(formatValue(undefined)).toBe("");
    expect(formatValue(null, "$#,##0.00")).toBe("");
  });

  test("non-numeric value with numeric spec falls back to String()", () => {
    expect(formatValue("N/A", "#,##0")).toBe("N/A");
  });
});

describe("js/format formatLabel", () => {
  test("display_name wins over the raw name", () => {
    const meta = { type: "double", display_name: "Avg LTV" };
    expect(formatLabel("avg_ltv", meta)).toBe("Avg LTV");
  });

  test("humanizes snake_case when no display_name", () => {
    expect(formatLabel("avg_ltv")).toBe("Avg Ltv");
  });

  test("humanizes camelCase", () => {
    expect(formatLabel("totalSpend")).toBe("Total Spend");
  });

  test("humanizes ALL_CAPS", () => {
    expect(formatLabel("TOTAL_SPEND")).toBe("Total Spend");
  });

  test("columnMeta without display_name falls back to humanize", () => {
    expect(formatLabel("user_name", { type: "string" })).toBe("User Name");
  });
});

describe("js/format toD3Format", () => {
  test("maps the common numeric specs", () => {
    expect(toD3Format("$#,##0.00")).toBe("$,.2f");
    expect(toD3Format("#,##0")).toBe(",.0f");
    expect(toD3Format("#,##0.00")).toBe(",.2f");
    expect(toD3Format("0.0%")).toBe(".1%");
  });

  test("no spec returns undefined", () => {
    expect(toD3Format()).toBeUndefined();
    expect(toD3Format("")).toBeUndefined();
  });

  test("unrecognized specs return undefined", () => {
    expect(toD3Format("yyyy-MM-dd")).toBeUndefined();
    expect(toD3Format("abc")).toBeUndefined();
  });
});
