import { describe, expect, test } from "vitest";
import { formatLabel, formatValue, toD3Format } from "./index";

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

  test("preserves bigint precision beyond 2^53 (no Number() rounding)", () => {
    // 9_007_199_254_740_993n = 2^53 + 1, which is NOT representable as a JS
    // number — Number(bigint) would round it to 9_007_199_254_740_992.
    expect(formatValue(9_007_199_254_740_993n, "#,##0")).toBe(
      "9,007,199,254,740,993",
    );
    expect(formatValue(9_007_199_254_740_993n, "$#,##0")).toBe(
      "$9,007,199,254,740,993",
    );
    expect(formatValue(-9_007_199_254_740_993n, "$#,##0")).toBe(
      "-$9,007,199,254,740,993",
    );
  });

  // The JSON_ARRAY wire path delivers numeric cells as strings, so an int64 /
  // large DECIMAL measure reaches the formatter as an integer-shaped string.
  // Routing it through Number() would round it before formatting.
  test("preserves precision for integer strings beyond 2^53", () => {
    expect(formatValue("9007199254740993", "#,##0")).toBe(
      "9,007,199,254,740,993",
    );
    expect(formatValue("9007199254740993", "$#,##0")).toBe(
      "$9,007,199,254,740,993",
    );
    expect(formatValue("-9007199254740993", "$#,##0")).toBe(
      "-$9,007,199,254,740,993",
    );
  });

  test("formats safe-range integer strings unchanged", () => {
    // Below the bigint threshold: the ordinary Number path still applies.
    expect(formatValue("1234567", "#,##0")).toBe("1,234,567");
    expect(formatValue("1234567", "#,##0.00")).toBe("1,234,567.00");
  });

  test("leaves fractional and exponent strings on the float path", () => {
    // Only plain integer strings qualify for exact formatting; a fraction or
    // exponent has no exact bigint reading.
    expect(formatValue("1234.5", "#,##0.00")).toBe("1,234.50");
    expect(formatValue("1e3", "#,##0")).toBe("1,000");
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

  // End-to-end over the currency symbols the metric-view generator emits
  // (mv-registry/describe.ts CURRENCY_SYMBOLS + the unknown-code fallback).
  // Each spec here is exactly what the generator produces for that symbol.
  describe("preserves every currency symbol the generator emits", () => {
    test.each([
      ["$#,##0.00", 1234.5, "$1,234.50"], // USD
      ["€#,##0.00", 1234.5, "€1,234.50"], // EUR
      ["£#,##0.00", 1234.5, "£1,234.50"], // GBP
      ["¥#,##0", 1234, "¥1,234"], // JPY / CNY
      ["₹#,##0.00", 1234.5, "₹1,234.50"], // INR
      ["R$#,##0.00", 1234.5, "R$1,234.50"], // BRL (multi-char symbol)
      ["XYZ #,##0.00", 1234.5, "XYZ 1,234.50"], // unknown ISO code + space
    ])("formatValue(%s) preserves the symbol", (spec, value, expected) => {
      expect(formatValue(value, spec)).toBe(expected);
    });

    test("negative currency keeps the sign before the symbol for every prefix", () => {
      expect(formatValue(-1234.5, "€#,##0.00")).toBe("-€1,234.50");
      expect(formatValue(-1234.5, "R$#,##0.00")).toBe("-R$1,234.50");
    });
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
    expect(toD3Format("$#,##0.00")).toEqual({
      specifier: ",.2f",
      prefix: "$",
    });
    expect(toD3Format("#,##0")).toEqual({ specifier: ",.0f" });
    expect(toD3Format("#,##0.00")).toEqual({ specifier: ",.2f" });
    expect(toD3Format("0.0%")).toEqual({ specifier: ".1%" });
  });

  test("no spec returns undefined", () => {
    expect(toD3Format()).toBeUndefined();
    expect(toD3Format("")).toBeUndefined();
  });

  test("unrecognized specs return undefined", () => {
    expect(toD3Format("yyyy-MM-dd")).toBeUndefined();
    expect(toD3Format("abc")).toBeUndefined();
  });

  // Currency stays separate from the d3 specifier because d3's `$` marker is
  // locale-driven and cannot encode arbitrary symbols. Consumers such as
  // Plotly can pass these through as `tickformat` + `tickprefix`.
  test.each([
    ["$#,##0.00", ",.2f", "$"],
    ["€#,##0.00", ",.2f", "€"],
    ["£#,##0.00", ",.2f", "£"],
    ["¥#,##0", ",.0f", "¥"],
    ["₹#,##0.00", ",.2f", "₹"],
    ["R$#,##0.00", ",.2f", "R$"],
    ["XYZ #,##0.00", ",.2f", "XYZ "],
  ])(
    "maps currency spec %s without replacing its prefix",
    (spec, specifier, prefix) => {
      expect(toD3Format(spec)).toEqual({ specifier, prefix });
    },
  );
});
