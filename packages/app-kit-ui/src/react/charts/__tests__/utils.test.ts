import { describe, expect, test } from "vitest";
import {
  createTimeSeriesData,
  formatLabel,
  sortTimeSeriesAscending,
  toChartArray,
  toChartValue,
  truncateLabel,
} from "../utils";

describe("toChartValue", () => {
  test("converts BigInt to number", () => {
    expect(toChartValue(BigInt(123))).toBe(123);
    expect(toChartValue(BigInt(-456))).toBe(-456);
    expect(toChartValue(BigInt(0))).toBe(0);
  });

  test("converts Date to timestamp", () => {
    const date = new Date("2025-01-01T00:00:00Z");
    expect(toChartValue(date)).toBe(date.getTime());
  });

  test("returns numbers as-is", () => {
    expect(toChartValue(42)).toBe(42);
    expect(toChartValue(3.14)).toBe(3.14);
    expect(toChartValue(-100)).toBe(-100);
  });

  test("returns strings as-is", () => {
    expect(toChartValue("hello")).toBe("hello");
    expect(toChartValue("")).toBe("");
  });

  test("handles null", () => {
    expect(toChartValue(null)).toBe(0);
  });

  test("handles undefined", () => {
    expect(toChartValue(undefined)).toBe(0);
  });

  test("converts other types to string", () => {
    // Implementation uses String() for other types
    expect(toChartValue(true)).toBe("true");
    expect(toChartValue(false)).toBe("false");
    expect(toChartValue({})).toBe("[object Object]");
  });
});

describe("toChartArray", () => {
  test("converts array of BigInt values", () => {
    const input = [BigInt(1), BigInt(2), BigInt(3)];
    const result = toChartArray(input);

    expect(result).toEqual([1, 2, 3]);
    result.forEach((v) => {
      expect(typeof v).toBe("number");
    });
  });

  test("converts array of Date values", () => {
    const dates = [new Date("2025-01-01"), new Date("2025-01-02")];
    const result = toChartArray(dates);

    expect(result[0]).toBe(dates[0].getTime());
    expect(result[1]).toBe(dates[1].getTime());
  });

  test("converts mixed array", () => {
    const input = [BigInt(1), new Date("2025-01-01"), 3, "four"];
    const result = toChartArray(input);

    expect(typeof result[0]).toBe("number");
    expect(typeof result[1]).toBe("number");
    expect(result[2]).toBe(3);
    expect(result[3]).toBe("four");
  });

  test("handles empty array", () => {
    expect(toChartArray([])).toEqual([]);
  });

  test("handles array with nulls", () => {
    const input = [1, null, 3];
    const result = toChartArray(input);

    expect(result).toEqual([1, 0, 3]);
  });
});

describe("formatLabel", () => {
  test("converts camelCase to Title Case", () => {
    expect(formatLabel("totalSpend")).toBe("Total Spend");
    expect(formatLabel("userCount")).toBe("User Count");
  });

  test("converts snake_case to Title Case", () => {
    expect(formatLabel("total_spend")).toBe("Total Spend");
    expect(formatLabel("user_count")).toBe("User Count");
  });

  test("handles single word", () => {
    expect(formatLabel("value")).toBe("Value");
    expect(formatLabel("count")).toBe("Count");
  });

  test("handles empty string", () => {
    expect(formatLabel("")).toBe("");
  });

  test("handles single letter", () => {
    expect(formatLabel("a")).toBe("A");
  });

  test("handles consecutive uppercase letters (acronyms)", () => {
    // Acronyms are kept together, then normalized to title case
    expect(formatLabel("userID")).toBe("User Id");
    expect(formatLabel("getHTTPUrl")).toBe("Get Http Url");
  });

  test("handles ALL_CAPS snake_case", () => {
    // ALL_CAPS is normalized to title case
    expect(formatLabel("TOTAL_SPEND")).toBe("Total Spend");
    expect(formatLabel("USER_COUNT")).toBe("User Count");
  });

  test("handles mixed camelCase and snake_case", () => {
    expect(formatLabel("total_spendAmount")).toBe("Total Spend Amount");
  });
});

describe("truncateLabel", () => {
  test("truncates long strings with ellipsis", () => {
    // Implementation: value.slice(0, maxLength) + "..."
    expect(truncateLabel("This is a very long label", 10)).toBe(
      "This is a ...",
    );
  });

  test("keeps short strings intact", () => {
    expect(truncateLabel("Short", 10)).toBe("Short");
  });

  test("handles exact length strings", () => {
    expect(truncateLabel("Exactly10!", 10)).toBe("Exactly10!");
  });

  test("handles empty string", () => {
    expect(truncateLabel("", 10)).toBe("");
  });

  test("handles maxLength of 0", () => {
    expect(truncateLabel("Hello", 0)).toBe("...");
  });

  test("handles maxLength of 1", () => {
    expect(truncateLabel("Hello", 1)).toBe("H...");
  });

  test("uses default maxLength of 15", () => {
    const short = "Short";
    const long = "This is definitely too long";
    expect(truncateLabel(short)).toBe("Short");
    expect(truncateLabel(long)).toBe("This is definit...");
  });
});

describe("sortTimeSeriesAscending", () => {
  test("sorts timestamp arrays in ascending order", () => {
    const xData = [3000, 1000, 2000];
    const yDataMap = { val: [30, 10, 20] };
    const yFields = ["val"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    expect(result.xData).toEqual([1000, 2000, 3000]);
    expect(result.yDataMap.val).toEqual([10, 20, 30]);
  });

  test("maintains correlation between x and y values", () => {
    const xData = [300, 100, 200];
    const yDataMap = {
      sales: [30, 10, 20],
      profit: [3, 1, 2],
    };
    const yFields = ["sales", "profit"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    expect(result.xData).toEqual([100, 200, 300]);
    expect(result.yDataMap.sales).toEqual([10, 20, 30]);
    expect(result.yDataMap.profit).toEqual([1, 2, 3]);
  });

  test("handles already sorted data", () => {
    const xData = [1, 2, 3];
    const yDataMap = { val: [10, 20, 30] };
    const yFields = ["val"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    expect(result.xData).toEqual([1, 2, 3]);
    expect(result.yDataMap.val).toEqual([10, 20, 30]);
  });

  test("handles reverse sorted data", () => {
    const xData = [3, 2, 1];
    const yDataMap = { val: [30, 20, 10] };
    const yFields = ["val"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    expect(result.xData).toEqual([1, 2, 3]);
    expect(result.yDataMap.val).toEqual([10, 20, 30]);
  });

  test("handles single element", () => {
    const xData = [1];
    const yDataMap = { val: [10] };
    const yFields = ["val"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    expect(result.xData).toEqual([1]);
    expect(result.yDataMap.val).toEqual([10]);
  });

  test("handles empty arrays", () => {
    const xData: number[] = [];
    const yDataMap = { val: [] as number[] };
    const yFields = ["val"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    expect(result.xData).toEqual([]);
    expect(result.yDataMap.val).toEqual([]);
  });

  test("does not sort string x-values", () => {
    // Only numeric timestamps get sorted
    const xData = ["C", "A", "B"];
    const yDataMap = { val: [30, 10, 20] };
    const yFields = ["val"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    // String values are not sorted (not time series)
    expect(result.xData).toEqual(["C", "A", "B"]);
    expect(result.yDataMap.val).toEqual([30, 10, 20]);
  });

  test("does not sort partially unsorted data where first <= last", () => {
    // Documents current behavior: only sorts when first > last (fully reversed)
    // Partially unsorted data like [1, 3, 2] is NOT sorted because first (1) <= last (2)
    const xData = [1, 3, 2];
    const yDataMap = { val: [10, 30, 20] };
    const yFields = ["val"];

    const result = sortTimeSeriesAscending(xData, yDataMap, yFields);

    // Returns unsorted - this is the current behavior
    expect(result.xData).toEqual([1, 3, 2]);
    expect(result.yDataMap.val).toEqual([10, 30, 20]);
  });
});

describe("createTimeSeriesData", () => {
  test("creates [timestamp, value] pairs", () => {
    const xData = [1704067200000, 1704153600000];
    const yData = [100, 200];

    const result = createTimeSeriesData(xData, yData);

    expect(result).toEqual([
      [1704067200000, 100],
      [1704153600000, 200],
    ]);
  });

  test("handles empty arrays", () => {
    expect(createTimeSeriesData([], [])).toEqual([]);
  });

  test("handles single data point", () => {
    const result = createTimeSeriesData([1000], [42]);
    expect(result).toEqual([[1000, 42]]);
  });

  test("uses xData length for result size with undefined for missing y values", () => {
    // Implementation uses xData.length, so missing y values become undefined
    const xData = [1, 2, 3];
    const yData = [10, 20];

    const result = createTimeSeriesData(xData, yData);

    expect(result).toEqual([
      [1, 10],
      [2, 20],
      [3, undefined],
    ]);
  });
});
