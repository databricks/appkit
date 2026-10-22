import { describe, expect, test } from "vitest";

import { classifySqlType, transformGenieData } from "../genie-query-transform";

// ---------------------------------------------------------------------------
// classifySqlType
// ---------------------------------------------------------------------------

describe("classifySqlType", () => {
  test("classifies numeric types", () => {
    for (const t of [
      "DECIMAL",
      "INT",
      "INTEGER",
      "BIGINT",
      "LONG",
      "FLOAT",
      "DOUBLE",
      "SMALLINT",
      "TINYINT",
      "SHORT",
      "BYTE",
    ]) {
      expect(classifySqlType(t)).toBe("numeric");
    }
  });

  test("classifies date types", () => {
    for (const t of ["DATE", "TIMESTAMP", "TIMESTAMP_NTZ"]) {
      expect(classifySqlType(t)).toBe("date");
    }
  });

  test("classifies string types", () => {
    for (const t of [
      "STRING",
      "VARCHAR",
      "CHAR",
      "BOOLEAN",
      "BINARY",
      "UNKNOWN",
    ]) {
      expect(classifySqlType(t)).toBe("string");
    }
  });

  test("is case-insensitive", () => {
    expect(classifySqlType("decimal")).toBe("numeric");
    expect(classifySqlType("Timestamp")).toBe("date");
  });
});

// ---------------------------------------------------------------------------
// transformGenieData
// ---------------------------------------------------------------------------

describe("transformGenieData", () => {
  function makeResponse(
    columns: Array<{ name: string; typeName: string }>,
    dataArray: (string | null)[][],
  ) {
    return {
      manifest: { schema: { columns } },
      result: { dataArray: dataArray },
    };
  }

  test("transforms basic numeric and string data", () => {
    const data = makeResponse(
      [
        { name: "region", typeName: "STRING" },
        { name: "sales", typeName: "DECIMAL" },
      ],
      [
        ["North", "1000.50"],
        ["South", "2000.75"],
      ],
    );

    const result = transformGenieData(data);
    expect(result).not.toBeNull();
    expect(result?.columns).toHaveLength(2);
    expect(result?.columns[0]).toEqual({
      name: "region",
      typeName: "STRING",
      category: "string",
    });
    expect(result?.columns[1]).toEqual({
      name: "sales",
      typeName: "DECIMAL",
      category: "numeric",
    });
    expect(result?.rows).toEqual([
      { region: "North", sales: 1000.5 },
      { region: "South", sales: 2000.75 },
    ]);
  });

  test("handles date columns as strings", () => {
    const data = makeResponse(
      [
        { name: "day", typeName: "DATE" },
        { name: "revenue", typeName: "INT" },
      ],
      [["2024-01-15", "500"]],
    );

    const result = transformGenieData(data);
    expect(result?.rows[0]).toEqual({ day: "2024-01-15", revenue: 500 });
    expect(result?.columns[0].category).toBe("date");
  });

  test("handles null values", () => {
    const data = makeResponse(
      [
        { name: "name", typeName: "STRING" },
        { name: "value", typeName: "INT" },
      ],
      [
        [null, "10"],
        ["foo", null],
      ],
    );

    const result = transformGenieData(data);
    expect(result?.rows).toEqual([
      { name: null, value: 10 },
      { name: "foo", value: null },
    ]);
  });

  test("handles non-numeric strings in numeric columns", () => {
    const data = makeResponse(
      [
        { name: "name", typeName: "STRING" },
        { name: "value", typeName: "INT" },
      ],
      [["a", "not_a_number"]],
    );

    const result = transformGenieData(data);
    expect(result?.rows[0].value).toBeNull();
  });

  test("returns null for empty dataArray", () => {
    const data = makeResponse([{ name: "a", typeName: "STRING" }], []);
    expect(transformGenieData(data)).toBeNull();
  });

  test("returns null for missing columns", () => {
    expect(
      transformGenieData({
        manifest: { schema: { columns: [] } },
        result: { dataArray: [["x"]] },
      }),
    ).toBeNull();
  });

  test("accepts the legacy snake_case shape", () => {
    const result = transformGenieData({
      manifest: { schema: { columns: [{ name: "n", type_name: "INT" }] } },
      result: { data_array: [["42"]] },
    });
    expect(result?.rows).toEqual([{ n: 42 }]);
    expect(result?.columns[0]).toMatchObject({ typeName: "INT" });
  });

  test("returns null for null/undefined input", () => {
    expect(transformGenieData(null)).toBeNull();
    expect(transformGenieData(undefined)).toBeNull();
  });

  test("handles rows shorter than columns (missing cells)", () => {
    const data = makeResponse(
      [
        { name: "a", typeName: "STRING" },
        { name: "b", typeName: "INT" },
      ],
      [["hello"]],
    );

    const result = transformGenieData(data);
    expect(result?.rows[0]).toEqual({ a: "hello", b: null });
  });
});
