import { describe, expect, test } from "vitest";
import {
  getCompatibleChartTypes,
  inferChartType,
} from "../genie-chart-inference";
import type { GenieColumnMeta } from "../genie-query-transform";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cols(
  ...defs: Array<[string, "numeric" | "date" | "string"]>
): GenieColumnMeta[] {
  return defs.map(([name, category]) => ({
    name,
    typeName: category.toUpperCase(),
    category,
  }));
}

function makeRows(
  keys: string[],
  data: unknown[][],
): Record<string, unknown>[] {
  return data.map((row) => {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      record[keys[i]] = row[i];
    }
    return record;
  });
}

// ---------------------------------------------------------------------------
// Skip rules
// ---------------------------------------------------------------------------

describe("inferChartType — skip rules", () => {
  test("returns null for < 2 rows", () => {
    const columns = cols(["name", "string"], ["value", "numeric"]);
    const rows = makeRows(["name", "value"], [["A", 10]]);
    expect(inferChartType(rows, columns)).toBeNull();
  });

  test("returns null for < 2 columns", () => {
    const columns = cols(["value", "numeric"]);
    const rows = makeRows(["value"], [[10], [20]]);
    expect(inferChartType(rows, columns)).toBeNull();
  });

  test("returns null when no numeric columns", () => {
    const columns = cols(["a", "string"], ["b", "string"]);
    const rows = makeRows(
      ["a", "b"],
      [
        ["x", "y"],
        ["w", "z"],
      ],
    );
    expect(inferChartType(rows, columns)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule 1: DATE + numeric(s) → line
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 1: timeseries", () => {
  test("date + single numeric → line", () => {
    const columns = cols(["day", "date"], ["revenue", "numeric"]);
    const rows = makeRows(
      ["day", "revenue"],
      [
        ["2024-01-01", 100],
        ["2024-01-02", 200],
      ],
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "line",
      xKey: "day",
      yKey: "revenue",
    });
  });

  test("date + multiple numerics → line with yKey array", () => {
    const columns = cols(
      ["month", "date"],
      ["revenue", "numeric"],
      ["cost", "numeric"],
    );
    const rows = makeRows(
      ["month", "revenue", "cost"],
      [
        ["2024-01", 100, 80],
        ["2024-02", 200, 150],
      ],
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "line",
      xKey: "month",
      yKey: ["revenue", "cost"],
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 2: STRING + 1 numeric, ≤7 categories → pie
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 2: pie", () => {
  test("string + 1 numeric, 3 categories → pie", () => {
    const columns = cols(["region", "string"], ["sales", "numeric"]);
    const rows = makeRows(
      ["region", "sales"],
      [
        ["North", 100],
        ["South", 200],
        ["East", 150],
      ],
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "pie",
      xKey: "region",
      yKey: "sales",
    });
  });

  test("string + 1 numeric, exactly 7 categories → pie", () => {
    const columns = cols(["cat", "string"], ["val", "numeric"]);
    const rows = makeRows(
      ["cat", "val"],
      Array.from({ length: 7 }, (_, i) => [`cat${i}`, i * 10]),
    );
    const result = inferChartType(rows, columns);
    expect(result?.chartType).toBe("pie");
  });
});

// ---------------------------------------------------------------------------
// Rule 3: STRING + 1 numeric, ≤100 categories → bar
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 3: bar", () => {
  test("string + 1 numeric, 15 categories → bar", () => {
    const columns = cols(["product", "string"], ["revenue", "numeric"]);
    const rows = makeRows(
      ["product", "revenue"],
      Array.from({ length: 15 }, (_, i) => [`product${i}`, i * 100]),
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "bar",
      xKey: "product",
      yKey: "revenue",
    });
  });

  test("boundary: 8 categories (just above pie threshold) → bar", () => {
    const columns = cols(["cat", "string"], ["val", "numeric"]);
    const rows = makeRows(
      ["cat", "val"],
      Array.from({ length: 8 }, (_, i) => [`cat${i}`, i]),
    );
    const result = inferChartType(rows, columns);
    expect(result?.chartType).toBe("bar");
  });
});

// ---------------------------------------------------------------------------
// Rule 4: STRING + 1 numeric, >100 categories → line
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 4: many categories → line", () => {
  test("string + 1 numeric, 150 categories → line", () => {
    const columns = cols(["city", "string"], ["population", "numeric"]);
    const rows = makeRows(
      ["city", "population"],
      Array.from({ length: 150 }, (_, i) => [`city${i}`, i * 1000]),
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "line",
      xKey: "city",
      yKey: "population",
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 5: STRING + N numerics, ≤50 categories → bar (grouped)
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 5: grouped bar", () => {
  test("string + 2 numerics, 8 categories → bar", () => {
    const columns = cols(
      ["department", "string"],
      ["budget", "numeric"],
      ["actual", "numeric"],
    );
    const rows = makeRows(
      ["department", "budget", "actual"],
      Array.from({ length: 8 }, (_, i) => [`dept${i}`, i * 100, i * 90]),
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "bar",
      xKey: "department",
      yKey: ["budget", "actual"],
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 6: STRING + N numerics, >50 categories → line
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 6: multi-series line", () => {
  test("string + 2 numerics, 60 categories → line", () => {
    const columns = cols(
      ["item", "string"],
      ["metric_a", "numeric"],
      ["metric_b", "numeric"],
    );
    const rows = makeRows(
      ["item", "metric_a", "metric_b"],
      Array.from({ length: 60 }, (_, i) => [`item${i}`, i, i * 2]),
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "line",
      xKey: "item",
      yKey: ["metric_a", "metric_b"],
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 7: 2+ numerics only → scatter
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 7: scatter", () => {
  test("2 numerics, no strings → scatter", () => {
    const columns = cols(["height", "numeric"], ["weight", "numeric"]);
    const rows = makeRows(
      ["height", "weight"],
      [
        [170, 70],
        [180, 80],
        [160, 55],
      ],
    );
    const result = inferChartType(rows, columns);
    expect(result).toEqual({
      chartType: "scatter",
      xKey: "height",
      yKey: "weight",
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 8: fallback
// ---------------------------------------------------------------------------

describe("inferChartType — Rule 8: fallback", () => {
  test("date + no numeric → null", () => {
    const columns = cols(["day", "date"], ["label", "string"]);
    const rows = makeRows(
      ["day", "label"],
      [
        ["2024-01-01", "a"],
        ["2024-01-02", "b"],
      ],
    );
    expect(inferChartType(rows, columns)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Priority: date takes precedence over string
// ---------------------------------------------------------------------------

describe("inferChartType — priority", () => {
  test("date + string + numeric → uses date (line), not string", () => {
    const columns = cols(
      ["day", "date"],
      ["region", "string"],
      ["sales", "numeric"],
    );
    const rows = makeRows(
      ["day", "region", "sales"],
      [
        ["2024-01-01", "North", 100],
        ["2024-01-02", "South", 200],
      ],
    );
    const result = inferChartType(rows, columns);
    expect(result?.chartType).toBe("line");
    expect(result?.xKey).toBe("day");
  });
});

describe("getCompatibleChartTypes", () => {
  test("returns [] for < 2 rows", () => {
    const columns = cols(["name", "string"], ["value", "numeric"]);
    const rows = makeRows(["name", "value"], [["A", 10]]);
    expect(getCompatibleChartTypes(rows, columns)).toEqual([]);
  });

  test("returns [] for < 2 columns", () => {
    const columns = cols(["value", "numeric"]);
    const rows = makeRows(["value"], [[10], [20]]);
    expect(getCompatibleChartTypes(rows, columns)).toEqual([]);
  });

  test("returns [] when no numeric columns", () => {
    const columns = cols(["a", "string"], ["b", "string"]);
    const rows = makeRows(
      ["a", "b"],
      [
        ["x", "y"],
        ["w", "z"],
      ],
    );
    expect(getCompatibleChartTypes(rows, columns)).toEqual([]);
  });

  test("date + numeric → line, bar, area", () => {
    const columns = cols(["day", "date"], ["revenue", "numeric"]);
    const rows = makeRows(
      ["day", "revenue"],
      [
        ["2024-01-01", 100],
        ["2024-01-02", 200],
      ],
    );
    expect(getCompatibleChartTypes(rows, columns)).toEqual([
      "line",
      "bar",
      "area",
    ]);
  });

  test("string + 1 numeric, few categories → includes pie and donut", () => {
    const columns = cols(["region", "string"], ["sales", "numeric"]);
    const rows = makeRows(
      ["region", "sales"],
      [
        ["North", 100],
        ["South", 200],
        ["East", 150],
      ],
    );
    expect(getCompatibleChartTypes(rows, columns)).toEqual([
      "pie",
      "donut",
      "bar",
      "line",
      "area",
    ]);
  });

  test("string + 1 numeric, many categories → bar, line, area (no pie)", () => {
    const columns = cols(["product", "string"], ["revenue", "numeric"]);
    const rows = makeRows(
      ["product", "revenue"],
      Array.from({ length: 15 }, (_, i) => [`product${i}`, i * 100]),
    );
    expect(getCompatibleChartTypes(rows, columns)).toEqual([
      "bar",
      "line",
      "area",
    ]);
  });

  test("string + N numerics → bar, line, area", () => {
    const columns = cols(
      ["department", "string"],
      ["budget", "numeric"],
      ["actual", "numeric"],
    );
    const rows = makeRows(
      ["department", "budget", "actual"],
      Array.from({ length: 8 }, (_, i) => [`dept${i}`, i * 100, i * 90]),
    );
    expect(getCompatibleChartTypes(rows, columns)).toEqual([
      "bar",
      "line",
      "area",
    ]);
  });

  test("2+ numerics only → scatter, line, area", () => {
    const columns = cols(["height", "numeric"], ["weight", "numeric"]);
    const rows = makeRows(
      ["height", "weight"],
      [
        [170, 70],
        [180, 80],
        [160, 55],
      ],
    );
    expect(getCompatibleChartTypes(rows, columns)).toEqual([
      "scatter",
      "line",
      "area",
    ]);
  });

  test("inferred type is always in the compatible list", () => {
    const columns = cols(["region", "string"], ["sales", "numeric"]);
    const rows = makeRows(
      ["region", "sales"],
      [
        ["North", 100],
        ["South", 200],
        ["East", 150],
      ],
    );
    const inference = inferChartType(rows, columns);
    const compatible = getCompatibleChartTypes(rows, columns);
    expect(inference).not.toBeNull();
    expect(compatible).toContain(inference?.chartType);
  });
});
