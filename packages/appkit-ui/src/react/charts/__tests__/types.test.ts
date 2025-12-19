import { describe, expect, test } from "vitest";
import { isArrowTable, isDataProps, isQueryProps } from "../types";

describe("isArrowTable", () => {
  test("returns true for Arrow-like objects", () => {
    const mockTable = {
      schema: { fields: [] },
      numRows: 10,
      numCols: 3,
      getChild: () => null,
    };

    expect(isArrowTable(mockTable as any)).toBe(true);
  });

  test("returns true for object with all required properties", () => {
    const mockTable = {
      schema: {},
      numRows: 0,
      getChild: () => {},
    };

    expect(isArrowTable(mockTable as any)).toBe(true);
  });

  test("returns false for JSON arrays", () => {
    expect(isArrowTable([{ a: 1 }, { a: 2 }])).toBe(false);
  });

  test("returns false for empty JSON array", () => {
    expect(isArrowTable([])).toBe(false);
  });

  test("returns false for null", () => {
    expect(isArrowTable(null as any)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isArrowTable(undefined as any)).toBe(false);
  });

  test("returns false for plain objects", () => {
    expect(isArrowTable({ foo: "bar" } as any)).toBe(false);
  });

  test("returns false for object missing getChild method", () => {
    const partialTable = {
      schema: {},
      numRows: 10,
      // missing getChild
    };

    expect(isArrowTable(partialTable as any)).toBe(false);
  });

  test("returns false for object missing schema", () => {
    const partialTable = {
      numRows: 10,
      getChild: () => null,
    };

    expect(isArrowTable(partialTable as any)).toBe(false);
  });

  test("returns false for object missing numRows", () => {
    const partialTable = {
      schema: {},
      getChild: () => null,
    };

    expect(isArrowTable(partialTable as any)).toBe(false);
  });

  test("returns false for object with getChild as non-function", () => {
    const invalidTable = {
      schema: {},
      numRows: 10,
      getChild: "not a function",
    };

    expect(isArrowTable(invalidTable as any)).toBe(false);
  });

  test("returns false for primitives", () => {
    expect(isArrowTable("string" as any)).toBe(false);
    expect(isArrowTable(123 as any)).toBe(false);
    expect(isArrowTable(true as any)).toBe(false);
  });
});

describe("isQueryProps", () => {
  test("identifies query-based props with queryKey", () => {
    const props = {
      queryKey: "test_query",
      parameters: { limit: 100 },
      format: "json" as const,
    };

    expect(isQueryProps(props as any)).toBe(true);
  });

  test("identifies query-based props with only queryKey", () => {
    const props = { queryKey: "minimal" };

    expect(isQueryProps(props as any)).toBe(true);
  });

  test("rejects data-based props", () => {
    const props = {
      data: [{ a: 1 }],
    };

    expect(isQueryProps(props as any)).toBe(false);
  });

  test("rejects props with undefined queryKey", () => {
    const props = {
      queryKey: undefined,
      parameters: {},
    };

    expect(isQueryProps(props as any)).toBe(false);
  });

  test("rejects empty object", () => {
    expect(isQueryProps({} as any)).toBe(false);
  });

  test("rejects props with empty string queryKey", () => {
    // Empty string is not a valid query key
    const props = { queryKey: "" };
    expect(isQueryProps(props as any)).toBe(false);
  });

  test("rejects props with null queryKey", () => {
    const props = { queryKey: null };
    expect(isQueryProps(props as any)).toBe(false);
  });
});

describe("isDataProps", () => {
  test("identifies data-based props with JSON array", () => {
    const props = {
      data: [
        { name: "A", value: 1 },
        { name: "B", value: 2 },
      ],
    };

    expect(isDataProps(props as any)).toBe(true);
  });

  test("identifies data-based props with empty array", () => {
    const props = { data: [] };

    expect(isDataProps(props as any)).toBe(true);
  });

  test("identifies data-based props with Arrow-like table", () => {
    const props = {
      data: {
        schema: {},
        numRows: 10,
        getChild: () => null,
      },
    };

    expect(isDataProps(props as any)).toBe(true);
  });

  test("rejects query-based props", () => {
    const props = {
      queryKey: "test",
      parameters: {},
    };

    expect(isDataProps(props as any)).toBe(false);
  });

  test("rejects props with undefined data", () => {
    const props = { data: undefined };

    expect(isDataProps(props as any)).toBe(false);
  });

  test("rejects empty object", () => {
    expect(isDataProps({} as any)).toBe(false);
  });

  test("rejects props with null data", () => {
    // null is not valid data
    const props = { data: null };
    expect(isDataProps(props as any)).toBe(false);
  });
});

describe("type discrimination", () => {
  test("queryKey and data are mutually exclusive in QueryProps", () => {
    const queryProps = {
      queryKey: "test",
      parameters: { limit: 10 },
      format: "auto" as const,
    };

    expect(isQueryProps(queryProps as any)).toBe(true);
    expect(isDataProps(queryProps as any)).toBe(false);
  });

  test("data and queryKey are mutually exclusive in DataProps", () => {
    const dataProps = {
      data: [{ x: 1, y: 2 }],
    };

    expect(isDataProps(dataProps as any)).toBe(true);
    expect(isQueryProps(dataProps as any)).toBe(false);
  });

  test("props with both queryKey and data returns true for both guards", () => {
    // This is an invalid state, but testing the behavior
    const invalidProps = {
      queryKey: "test",
      data: [{ a: 1 }],
    };

    // Both guards would return true for this invalid state
    // The component should handle this at runtime
    expect(isQueryProps(invalidProps as any)).toBe(true);
    expect(isDataProps(invalidProps as any)).toBe(true);
  });
});
