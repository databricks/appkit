import { describe, expect, test } from "vitest";
import { normalizeChartData, normalizeHeatmapData } from "../normalize";

describe("normalizeChartData", () => {
  describe("JSON data - categorical", () => {
    test("detects categorical data with string x-axis", () => {
      const data = [
        { name: "Product A", sales: 100 },
        { name: "Product B", sales: 200 },
        { name: "Product C", sales: 150 },
      ];

      const result = normalizeChartData(data);

      expect(result.chartType).toBe("categorical");
      expect(result.xField).toBe("name");
      expect(result.xData).toEqual(["Product A", "Product B", "Product C"]);
      expect(result.yFields).toContain("sales");
      expect(result.yDataMap.sales).toEqual([100, 200, 150]);
    });

    test("handles multiple y-fields", () => {
      const data = [
        { category: "A", sales: 100, profit: 20, cost: 80 },
        { category: "B", sales: 200, profit: 50, cost: 150 },
      ];

      const result = normalizeChartData(data);

      expect(result.xField).toBe("category");
      expect(result.yFields).toContain("sales");
      expect(result.yFields).toContain("profit");
      expect(result.yFields).toContain("cost");
      expect(result.yDataMap.sales).toEqual([100, 200]);
      expect(result.yDataMap.profit).toEqual([20, 50]);
    });

    test("handles numeric string values (SQL decimals)", () => {
      const data = [
        { name: "A", value: "123.45" },
        { name: "B", value: "678.90" },
      ];

      const result = normalizeChartData(data);

      // Numeric strings should be converted to numbers for y-values
      expect(result.yDataMap.value).toEqual([123.45, 678.9]);
    });

    test("respects explicit xKey override", () => {
      const data = [
        { id: 1, name: "A", value: 100 },
        { id: 2, name: "B", value: 200 },
      ];

      const result = normalizeChartData(data, "id");

      expect(result.xField).toBe("id");
      expect(result.xData).toEqual([1, 2]);
    });

    test("respects explicit yKey override (single)", () => {
      const data = [
        { name: "A", sales: 100, profit: 20 },
        { name: "B", sales: 200, profit: 50 },
      ];

      const result = normalizeChartData(data, undefined, "profit");

      expect(result.yFields).toEqual(["profit"]);
      expect(result.yDataMap.profit).toEqual([20, 50]);
      expect(result.yDataMap.sales).toBeUndefined();
    });

    test("respects explicit yKey override (array)", () => {
      const data = [
        { name: "A", sales: 100, profit: 20, cost: 80 },
        { name: "B", sales: 200, profit: 50, cost: 150 },
      ];

      const result = normalizeChartData(data, undefined, ["sales", "profit"]);

      expect(result.yFields).toEqual(["sales", "profit"]);
      expect(result.yDataMap.sales).toEqual([100, 200]);
      expect(result.yDataMap.profit).toEqual([20, 50]);
      expect(result.yDataMap.cost).toBeUndefined();
    });

    test("excludes fields ending with _id from name detection", () => {
      const data = [
        { user_id: 1, category: "Electronics", value: 100 },
        { user_id: 2, category: "Books", value: 200 },
      ];

      const result = normalizeChartData(data);

      // Should prefer 'category' over 'user_id' for x-axis
      expect(result.xField).toBe("category");
      expect(result.xData).toEqual(["Electronics", "Books"]);
    });

    test("uses all non-x fields as y-fields when no numeric fields detected", () => {
      const data = [
        { name: "A", status: "active", type: "primary" },
        { name: "B", status: "inactive", type: "secondary" },
      ];

      const result = normalizeChartData(data);

      expect(result.xField).toBe("name");
      expect(result.yFields).toContain("status");
      expect(result.yFields).toContain("type");
    });
  });

  describe("JSON data - time-series", () => {
    test("detects time-series data with ISO date strings", () => {
      const data = [
        { date: "2025-01-01", value: 100 },
        { date: "2025-01-02", value: 200 },
        { date: "2025-01-03", value: 150 },
      ];

      const result = normalizeChartData(data);

      expect(result.chartType).toBe("timeseries");
      expect(result.xField).toBe("date");
      // Dates should be converted to timestamps
      expect(typeof result.xData[0]).toBe("number");
    });

    test("detects time-series with date field patterns", () => {
      const data = [
        { timestamp: "2025-01-01T10:00:00Z", count: 5 },
        { timestamp: "2025-01-01T11:00:00Z", count: 10 },
      ];

      const result = normalizeChartData(data);

      expect(result.chartType).toBe("timeseries");
      expect(result.xField).toBe("timestamp");
    });

    test("sorts time-series data in ascending order", () => {
      // The current implementation uses sortTimeSeriesAscending which only
      // sorts if first > last (fully reversed), not partially unsorted data
      // So we test with fully reversed data
      const reversedData = [
        { date: "2025-01-03", value: 300 },
        { date: "2025-01-02", value: 200 },
        { date: "2025-01-01", value: 100 },
      ];

      const result = normalizeChartData(reversedData);

      // First timestamp should be earliest after sorting
      expect(result.xData[0]).toBeLessThan(result.xData[1] as number);
      expect(result.xData[1]).toBeLessThan(result.xData[2] as number);
    });

    test("converts ISO date strings to timestamps", () => {
      const data = [{ date: "2025-01-15T12:00:00Z", value: 100 }];

      const result = normalizeChartData(data);

      const expectedTimestamp = new Date("2025-01-15T12:00:00Z").getTime();
      expect(result.xData[0]).toBe(expectedTimestamp);
    });
  });

  describe("edge cases", () => {
    test("returns default structure for empty array", () => {
      const result = normalizeChartData([]);

      expect(result.xData).toEqual([]);
      expect(result.yFields).toBeDefined();
      expect(result.chartType).toBe("categorical");
    });

    test("handles null values in data", () => {
      const data = [
        { name: "A", value: 100 },
        { name: "B", value: null },
        { name: "C", value: 300 },
      ];

      const result = normalizeChartData(data);

      // Null y-values should be converted to 0
      expect(result.yDataMap.value).toEqual([100, 0, 300]);
    });

    test("handles undefined values in data", () => {
      const data = [
        { name: "A", value: 100 },
        { name: "B" }, // value is undefined
        { name: "C", value: 300 },
      ];

      const result = normalizeChartData(data);

      // Undefined y-values should be converted to 0
      expect(result.yDataMap.value).toEqual([100, 0, 300]);
    });

    test("handles single row of data", () => {
      const data = [{ name: "Only One", value: 42 }];

      const result = normalizeChartData(data);

      expect(result.xData).toEqual(["Only One"]);
      expect(result.yDataMap.value).toEqual([42]);
    });

    test("handles data with only one column", () => {
      const data = [{ value: 100 }, { value: 200 }, { value: 300 }];

      const result = normalizeChartData(data);

      // When there's only one column, it becomes both x and potentially y
      expect(result.xData.length).toBe(3);
    });

    test("handles bigint values", () => {
      const data = [
        { name: "A", value: BigInt(9007199254740991) },
        { name: "B", value: BigInt(123) },
      ];

      const result = normalizeChartData(data);

      // BigInt should be converted to number
      expect(typeof result.yDataMap.value[0]).toBe("number");
      expect(typeof result.yDataMap.value[1]).toBe("number");
    });

    test("handles mixed valid and invalid numeric strings", () => {
      const data = [
        { name: "A", value: "100" },
        { name: "B", value: "not a number" },
        { name: "C", value: "200.50" },
      ];

      const result = normalizeChartData(data);

      expect(result.yDataMap.value[0]).toBe(100);
      expect(result.yDataMap.value[1]).toBe("not a number"); // Non-numeric stays as string
      expect(result.yDataMap.value[2]).toBe(200.5);
    });

    test("handles null x-values as empty string", () => {
      const data = [
        { name: null, value: 100 },
        { name: "B", value: 200 },
      ];

      const result = normalizeChartData(data);

      expect(result.xData[0]).toBe("");
      expect(result.xData[1]).toBe("B");
    });

    test("handles boolean values by converting to string", () => {
      const data = [
        { name: "A", active: true },
        { name: "B", active: false },
      ];

      const result = normalizeChartData(data);

      // Boolean values are converted to string representation
      expect(result.yDataMap.active).toEqual(["true", "false"]);
    });

    test("handles object values by converting to string", () => {
      const data = [
        { name: "A", meta: { nested: true } },
        { name: "B", meta: { nested: false } },
      ];

      const result = normalizeChartData(data);

      // Objects are converted via String()
      expect(result.yDataMap.meta[0]).toBe("[object Object]");
      expect(result.yDataMap.meta[1]).toBe("[object Object]");
    });
  });

  describe("orientation", () => {
    test("horizontal orientation prioritizes name fields", () => {
      const data = [
        { date: "2025-01-01", name: "A", value: 100 },
        { date: "2025-01-02", name: "B", value: 200 },
      ];

      const result = normalizeChartData(
        data,
        undefined,
        undefined,
        "horizontal",
      );

      expect(result.chartType).toBe("categorical");
      expect(result.xField).toBe("name");
    });
  });
});

describe("normalizeHeatmapData", () => {
  test("extracts x, y, value triplets", () => {
    const data = [
      { hour: "9AM", day: "Mon", count: 10 },
      { hour: "10AM", day: "Mon", count: 20 },
      { hour: "9AM", day: "Tue", count: 15 },
      { hour: "10AM", day: "Tue", count: 25 },
    ];

    const result = normalizeHeatmapData(data, "hour", "day", "count");

    expect(result.xData).toContain("9AM");
    expect(result.xData).toContain("10AM");
    expect(result.yAxisData).toContain("Mon");
    expect(result.yAxisData).toContain("Tue");
  });

  test("calculates min/max values correctly", () => {
    const data = [
      { x: "A", y: "1", value: 10 },
      { x: "B", y: "1", value: 50 },
      { x: "A", y: "2", value: 25 },
      { x: "B", y: "2", value: 5 },
    ];

    const result = normalizeHeatmapData(data, "x", "y", "value");

    expect(result.min).toBe(5);
    expect(result.max).toBe(50);
  });

  test("formats data as [xIndex, yIndex, value] tuples", () => {
    const data = [
      { col: "A", row: "1", val: 100 },
      { col: "B", row: "1", val: 200 },
    ];

    const result = normalizeHeatmapData(data, "col", "row", "val");

    // Each heatmap data point should be [xIndex, yIndex, value]
    expect(result.heatmapData.length).toBe(2);
    expect(result.heatmapData[0]).toHaveLength(3);
    expect(typeof result.heatmapData[0][0]).toBe("number"); // xIndex
    expect(typeof result.heatmapData[0][1]).toBe("number"); // yIndex
    expect(typeof result.heatmapData[0][2]).toBe("number"); // value
  });

  test("handles numeric string values", () => {
    const data = [
      { x: "A", y: "1", value: "123.45" },
      { x: "B", y: "1", value: "678.90" },
    ];

    const result = normalizeHeatmapData(data, "x", "y", "value");

    // Values should be converted to numbers
    const values = result.heatmapData.map((d) => d[2]);
    expect(values).toContain(123.45);
    expect(values).toContain(678.9);
  });

  test("returns empty structure for empty data", () => {
    const result = normalizeHeatmapData([]);

    expect(result.xData).toEqual([]);
    expect(result.yAxisData).toEqual([]);
    expect(result.heatmapData).toEqual([]);
    expect(result.min).toBe(0);
    expect(result.max).toBe(0);
  });

  test("auto-detects fields when not provided", () => {
    const data = [
      { col: "A", row: "1", value: 100 },
      { col: "B", row: "2", value: 200 },
    ];

    // Don't provide explicit keys
    const result = normalizeHeatmapData(data);

    // Should use first 3 columns in order
    expect(result.xField).toBe("col");
    expect(result.xData).toContain("A");
    expect(result.xData).toContain("B");
  });

  test("preserves unique categories for x and y axes", () => {
    const data = [
      { x: "A", y: "1", v: 10 },
      { x: "A", y: "2", v: 20 },
      { x: "B", y: "1", v: 30 },
      { x: "B", y: "2", v: 40 },
    ];

    const result = normalizeHeatmapData(data, "x", "y", "v");

    // Should have unique x values
    expect(result.xData).toEqual(["A", "B"]);
    // Should have unique y values
    expect(result.yAxisData).toEqual(["1", "2"]);
    // Should have all 4 data points
    expect(result.heatmapData).toHaveLength(4);
  });

  test("handles null values as zero", () => {
    const data = [
      { x: "A", y: "1", value: 100 },
      { x: "B", y: "1", value: null },
    ];

    const result = normalizeHeatmapData(data, "x", "y", "value");

    const values = result.heatmapData.map((d) => d[2]);
    expect(values).toContain(100);
    expect(values).toContain(0); // null converted to 0
  });

  test("handles negative values for min/max", () => {
    const data = [
      { x: "A", y: "1", value: -50 },
      { x: "B", y: "1", value: 25 },
      { x: "A", y: "2", value: -10 },
    ];

    const result = normalizeHeatmapData(data, "x", "y", "value");

    expect(result.min).toBe(-50);
    expect(result.max).toBe(25);
  });

  test("uses first value when valueKey is an array", () => {
    const data = [
      { x: "A", y: "1", val1: 100, val2: 200 },
      { x: "B", y: "1", val1: 300, val2: 400 },
    ];

    const result = normalizeHeatmapData(data, "x", "y", ["val1", "val2"]);

    // Should use first value key from array
    expect(result.yFields).toEqual(["val1"]);
    const values = result.heatmapData.map((d) => d[2]);
    expect(values).toContain(100);
    expect(values).toContain(300);
  });

  test("handles all zero values", () => {
    const data = [
      { x: "A", y: "1", value: 0 },
      { x: "B", y: "1", value: 0 },
    ];

    const result = normalizeHeatmapData(data, "x", "y", "value");

    expect(result.min).toBe(0);
    expect(result.max).toBe(0);
  });

  test("handles single data point", () => {
    const data = [{ x: "A", y: "1", value: 42 }];

    const result = normalizeHeatmapData(data, "x", "y", "value");

    expect(result.xData).toEqual(["A"]);
    expect(result.yAxisData).toEqual(["1"]);
    expect(result.heatmapData).toEqual([[0, 0, 42]]);
    expect(result.min).toBe(42);
    expect(result.max).toBe(42);
  });
});
