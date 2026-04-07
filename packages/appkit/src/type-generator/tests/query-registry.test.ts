import { describe, expect, test } from "vitest";
import {
  convertToQueryType,
  defaultForType,
  extractParameters,
  extractParameterTypes,
  getProtectedRanges,
  inferParameterTypes,
  normalizeTypeName,
  SERVER_INJECTED_PARAMS,
} from "../query-registry";
import type { DatabricksStatementExecutionResponse } from "../types";

describe("normalizeTypeName", () => {
  test("returns simple types unchanged", () => {
    expect(normalizeTypeName("STRING")).toBe("STRING");
    expect(normalizeTypeName("INT")).toBe("INT");
    expect(normalizeTypeName("BOOLEAN")).toBe("BOOLEAN");
  });

  test("removes precision/scale from DECIMAL", () => {
    expect(normalizeTypeName("DECIMAL(38,6)")).toBe("DECIMAL");
    expect(normalizeTypeName("DECIMAL(10,2)")).toBe("DECIMAL");
  });

  test("removes srid from spatial types", () => {
    expect(normalizeTypeName("GEOGRAPHY(4326)")).toBe("GEOGRAPHY");
    expect(normalizeTypeName("GEOMETRY(4326)")).toBe("GEOMETRY");
  });

  test("removes element type from ARRAY", () => {
    expect(normalizeTypeName("ARRAY<STRING>")).toBe("ARRAY");
    expect(normalizeTypeName("ARRAY<INT>")).toBe("ARRAY");
  });

  test("removes key/value types from MAP", () => {
    expect(normalizeTypeName("MAP<STRING,INT>")).toBe("MAP");
    expect(normalizeTypeName("MAP<STRING,ARRAY<INT>>")).toBe("MAP");
  });

  test("removes field definitions from STRUCT", () => {
    expect(normalizeTypeName("STRUCT<name:STRING,age:INT>")).toBe("STRUCT");
  });

  test("removes qualifier from INTERVAL", () => {
    expect(normalizeTypeName("INTERVAL DAY TO SECOND")).toBe("INTERVAL");
    expect(normalizeTypeName("INTERVAL YEAR TO MONTH")).toBe("INTERVAL");
  });
});

describe("extractParameters", () => {
  test("extracts parameters from SQL query", () => {
    const sql = "SELECT * FROM users WHERE id = :userId AND status = :status";
    const params = extractParameters(sql);

    expect(params).toContain("userId");
    expect(params).toContain("status");
    expect(params.length).toBe(2);
  });

  test("extracts unique parameters (no duplicates)", () => {
    const sql =
      "SELECT * FROM users WHERE id = :userId OR created_by = :userId";
    const params = extractParameters(sql);

    expect(params).toEqual(["userId"]);
  });

  test("returns empty array for SQL without parameters", () => {
    const sql = "SELECT * FROM users";
    const params = extractParameters(sql);

    expect(params).toEqual([]);
  });

  test("handles complex parameter names", () => {
    const sql =
      "SELECT * FROM data WHERE start_date = :startDate AND workspace_id = :workspaceId";
    const params = extractParameters(sql);

    expect(params).toContain("startDate");
    expect(params).toContain("workspaceId");
  });

  test("skips parameters inside string literals", () => {
    const sql = "SELECT * FROM t WHERE name = ':fake' AND id = :real";
    const params = extractParameters(sql);

    expect(params).toEqual(["real"]);
  });

  test("skips parameters inside single-line comments", () => {
    const sql = "-- filter by :commented\nSELECT * FROM t WHERE id = :actual";
    const params = extractParameters(sql);

    expect(params).toEqual(["actual"]);
  });

  test("skips params in both strings and comments, keeps real ones", () => {
    const sql = `-- :hidden
SELECT * FROM t WHERE x = ':also_hidden' AND y = :visible`;
    const params = extractParameters(sql);

    expect(params).toEqual(["visible"]);
  });

  test("extracts params after a string containing --", () => {
    const sql = "SELECT '--' AS marker, :id FROM t";
    const params = extractParameters(sql);

    expect(params).toEqual(["id"]);
  });

  test("handles escaped quotes in string literals", () => {
    const sql = "SELECT * FROM t WHERE name = 'it''s fine' AND id = :userId";
    const params = extractParameters(sql);

    expect(params).toEqual(["userId"]);
  });
});

describe("SERVER_INJECTED_PARAMS", () => {
  test("includes workspaceId", () => {
    expect(SERVER_INJECTED_PARAMS).toContain("workspaceId");
  });
});

describe("extractParameterTypes", () => {
  test("extracts parameter types from SQL comments", () => {
    const sql = `-- @param startDate DATE
-- @param endDate DATE
-- @param groupBy STRING
SELECT * FROM users WHERE date BETWEEN :startDate AND :endDate`;
    const types = extractParameterTypes(sql);

    expect(types.startDate).toBe("DATE");
    expect(types.endDate).toBe("DATE");
    expect(types.groupBy).toBe("STRING");
  });

  test("returns empty object for SQL without @param comments", () => {
    const sql = "SELECT * FROM users WHERE date = :startDate";
    const types = extractParameterTypes(sql);

    expect(Object.keys(types).length).toBe(0);
  });

  test("handles all supported types", () => {
    const sql = `-- @param str STRING
-- @param num NUMERIC
-- @param bool BOOLEAN
-- @param dt DATE
-- @param ts TIMESTAMP
-- @param bin BINARY
SELECT 1`;
    const types = extractParameterTypes(sql);

    expect(types.str).toBe("STRING");
    expect(types.num).toBe("NUMERIC");
    expect(types.bool).toBe("BOOLEAN");
    expect(types.dt).toBe("DATE");
    expect(types.ts).toBe("TIMESTAMP");
    expect(types.bin).toBe("BINARY");
  });

  test("ignores malformed @param comments", () => {
    const sql = `-- @param startDate
-- @param INVALID
-- @param noType
-- this is not a param comment
SELECT 1`;
    const types = extractParameterTypes(sql);

    expect(Object.keys(types).length).toBe(0);
  });

  test("handles mixed valid and invalid annotations", () => {
    const sql = `-- @param validDate DATE
-- @param invalidParam
-- @param validString STRING
SELECT 1`;
    const types = extractParameterTypes(sql);

    expect(types.validDate).toBe("DATE");
    expect(types.validString).toBe("STRING");
    expect(types.invalidParam).toBeUndefined();
    expect(Object.keys(types).length).toBe(2);
  });
});

describe("defaultForType", () => {
  test("returns '0' for NUMERIC", () => {
    expect(defaultForType("NUMERIC")).toBe("0");
  });

  test("returns empty string literal for STRING", () => {
    expect(defaultForType("STRING")).toBe("''");
  });

  test("returns 'true' for BOOLEAN", () => {
    expect(defaultForType("BOOLEAN")).toBe("true");
  });

  test("returns date literal for DATE", () => {
    expect(defaultForType("DATE")).toBe("'2000-01-01'");
  });

  test("returns timestamp literal for TIMESTAMP", () => {
    expect(defaultForType("TIMESTAMP")).toBe("'2000-01-01T00:00:00Z'");
  });

  test("returns binary literal for BINARY", () => {
    expect(defaultForType("BINARY")).toBe("X'00'");
  });

  test("returns empty string literal for undefined (unknown fallback)", () => {
    expect(defaultForType(undefined)).toBe("''");
  });

  test("is case insensitive", () => {
    expect(defaultForType("numeric")).toBe("0");
    expect(defaultForType("Numeric")).toBe("0");
    expect(defaultForType("boolean")).toBe("true");
    expect(defaultForType("date")).toBe("'2000-01-01'");
  });
});

describe("convertToQueryType", () => {
  // DESCRIBE QUERY returns rows as [col_name, data_type, comment]
  const mockResponse: DatabricksStatementExecutionResponse = {
    statement_id: "test-123",
    status: { state: "SUCCEEDED" },
    result: {
      data_array: [
        ["id", "STRING", null],
        ["name", "STRING", null],
        ["count", "INT", null],
      ],
    },
  };

  test("generates query type with parameters", () => {
    const sql = "SELECT * FROM users WHERE start_date = :startDate";
    const { type } = convertToQueryType(mockResponse, sql, "users");

    expect(type).toContain('name: "users"');
    expect(type).toContain("parameters:");
    expect(type).toContain("startDate: SQLTypeMarker");
    expect(type).toContain("result: Array<{");
  });

  test("excludes server-injected params from parameters type", () => {
    const sql =
      "SELECT * FROM users WHERE workspace_id = :workspaceId AND date = :startDate";
    const { type } = convertToQueryType(mockResponse, sql, "users");

    expect(type).toContain("startDate: SQLTypeMarker");
    expect(type).not.toContain("workspaceId:");
  });

  test("uses specific marker types when @param annotation is provided", () => {
    const sql = `-- @param startDate DATE
-- @param count NUMERIC
-- @param name STRING
SELECT * FROM users WHERE date = :startDate AND count = :count AND name = :name`;
    const { type } = convertToQueryType(mockResponse, sql, "users");

    expect(type).toContain("startDate: SQLDateMarker");
    expect(type).toContain("count: SQLNumberMarker");
    expect(type).toContain("name: SQLStringMarker");
  });

  test("generates Record<string, never> for queries without params", () => {
    const sql = "SELECT * FROM users";
    const { type } = convertToQueryType(mockResponse, sql, "users");

    expect(type).toContain("parameters: Record<string, never>");
  });

  test("maps column types correctly", () => {
    const { type } = convertToQueryType(mockResponse, "SELECT 1", "test");

    expect(type).toContain("id: string");
    expect(type).toContain("name: string");
    expect(type).toContain("count: number");
  });

  test("adds JSDoc comments with @sqlType", () => {
    const { type } = convertToQueryType(mockResponse, "SELECT 1", "test");

    expect(type).toContain("/** @sqlType STRING */");
    expect(type).toContain("/** @sqlType INT */");
  });

  test("uses column comment when available", () => {
    const responseWithComment: DatabricksStatementExecutionResponse = {
      statement_id: "test-123",
      status: { state: "SUCCEEDED" },
      result: {
        data_array: [["total", "DECIMAL", "Total amount in USD"]],
      },
    };

    const { type } = convertToQueryType(
      responseWithComment,
      "SELECT 1",
      "test",
    );

    expect(type).toContain("/** Total amount in USD */");
  });

  test("quotes invalid column identifiers", () => {
    const responseWithInvalidName: DatabricksStatementExecutionResponse = {
      statement_id: "test-123",
      status: { state: "SUCCEEDED" },
      result: {
        data_array: [["(1 = 1)", "BOOLEAN", null]],
      },
    };

    const { type } = convertToQueryType(
      responseWithInvalidName,
      "SELECT 1",
      "test",
    );

    expect(type).toContain('"(1 = 1)": boolean');
  });

  test("returns hasResults: true when columns exist", () => {
    const { hasResults } = convertToQueryType(mockResponse, "SELECT 1", "test");
    expect(hasResults).toBe(true);
  });

  test("returns hasResults: false when no columns exist", () => {
    const emptyResponse: DatabricksStatementExecutionResponse = {
      statement_id: "test-123",
      status: { state: "SUCCEEDED" },
      result: { data_array: [] },
    };
    const { hasResults } = convertToQueryType(
      emptyResponse,
      "SELECT 1",
      "test",
    );
    expect(hasResults).toBe(false);
  });
});

describe("inferParameterTypes", () => {
  test("infers NUMERIC from LIMIT :count", () => {
    const result = inferParameterTypes("SELECT * FROM t LIMIT :count");
    expect(result).toEqual({ count: "NUMERIC" });
  });

  test("infers NUMERIC from OFFSET :skip", () => {
    const result = inferParameterTypes("SELECT * FROM t LIMIT 10 OFFSET :skip");
    expect(result).toEqual({ skip: "NUMERIC" });
  });

  test("infers NUMERIC from TOP :n", () => {
    const result = inferParameterTypes("SELECT TOP :n * FROM t");
    expect(result).toEqual({ n: "NUMERIC" });
  });

  test("infers NUMERIC from FETCH FIRST :pageSize ROWS", () => {
    const result = inferParameterTypes(
      "SELECT * FROM t FETCH FIRST :pageSize ROWS ONLY",
    );
    expect(result).toEqual({ pageSize: "NUMERIC" });
  });

  test("infers NUMERIC from arithmetic operators", () => {
    const sql = "SELECT price + :tax, quantity * :factor FROM orders";
    const result = inferParameterTypes(sql);
    expect(result.tax).toBe("NUMERIC");
    expect(result.factor).toBe("NUMERIC");
  });

  test("infers NUMERIC from subtraction and division", () => {
    const sql = "SELECT total - :discount, amount / :divisor FROM orders";
    const result = inferParameterTypes(sql);
    expect(result.discount).toBe("NUMERIC");
    expect(result.divisor).toBe("NUMERIC");
  });

  test("does NOT infer params inside string literals", () => {
    const sql = "SELECT * FROM t WHERE name = 'LIMIT :fake'";
    const result = inferParameterTypes(sql);
    expect(result).toEqual({});
  });

  test("does NOT infer params inside SQL comments", () => {
    const sql = "-- LIMIT :fake\nSELECT * FROM t LIMIT :real";
    const result = inferParameterTypes(sql);
    expect(result).toEqual({ real: "NUMERIC" });
    expect(result.fake).toBeUndefined();
  });

  test("handles multiple params in one query with mixed contexts", () => {
    const sql = "SELECT * FROM t WHERE name = :name LIMIT :count OFFSET :skip";
    const result = inferParameterTypes(sql);
    expect(result.count).toBe("NUMERIC");
    expect(result.skip).toBe("NUMERIC");
    expect(result.name).toBeUndefined();
  });

  test("same param in multiple inferrable positions resolves consistently", () => {
    const sql = "SELECT * FROM t LIMIT :n OFFSET :n";
    const result = inferParameterTypes(sql);
    expect(result.n).toBe("NUMERIC");
  });

  test("annotations override inferences when merged", () => {
    const sql = `-- @param count STRING
SELECT * FROM t LIMIT :count`;
    const inferred = inferParameterTypes(sql);
    const annotated = extractParameterTypes(sql);
    const merged = { ...inferred, ...annotated };
    // Annotation wins
    expect(merged.count).toBe("STRING");
  });

  test("returns empty object for params not in any pattern", () => {
    const sql = "SELECT * FROM t WHERE id = :userId";
    const result = inferParameterTypes(sql);
    expect(result).toEqual({});
  });

  test("is case insensitive for SQL keywords", () => {
    expect(inferParameterTypes("select * from t limit :x")).toEqual({
      x: "NUMERIC",
    });
    expect(inferParameterTypes("SELECT * FROM t LIMIT :x")).toEqual({
      x: "NUMERIC",
    });
    expect(inferParameterTypes("Select * From t Limit :x")).toEqual({
      x: "NUMERIC",
    });
  });
});

describe("getProtectedRanges", () => {
  test("returns ranges for string literals", () => {
    const sql = "SELECT * FROM t WHERE name = 'hello'";
    const ranges = getProtectedRanges(sql);

    expect(ranges).toHaveLength(1);
    expect(sql.slice(ranges[0][0], ranges[0][1])).toBe("'hello'");
  });

  test("returns ranges for single-line comments", () => {
    const sql = "-- this is a comment\nSELECT 1";
    const ranges = getProtectedRanges(sql);

    expect(ranges).toHaveLength(1);
    expect(sql.slice(ranges[0][0], ranges[0][1])).toBe("-- this is a comment");
  });

  test("returns ranges for both literals and comments", () => {
    const sql = "-- comment\nSELECT * FROM t WHERE x = 'val'";
    const ranges = getProtectedRanges(sql);

    expect(ranges).toHaveLength(2);
    const texts = ranges.map(([s, e]) => sql.slice(s, e));
    expect(texts).toContain("-- comment");
    expect(texts).toContain("'val'");
  });

  test("returns empty array when no literals or comments", () => {
    expect(getProtectedRanges("SELECT 1")).toEqual([]);
  });

  test("handles multiple string literals", () => {
    const sql = "SELECT * FROM t WHERE a = 'x' AND b = 'y'";
    const ranges = getProtectedRanges(sql);

    expect(ranges).toHaveLength(2);
    const texts = ranges.map(([s, e]) => sql.slice(s, e));
    expect(texts).toContain("'x'");
    expect(texts).toContain("'y'");
  });

  test("does not treat -- inside a string literal as a comment", () => {
    const sql = "SELECT '--' AS marker, :id FROM t";
    const ranges = getProtectedRanges(sql);

    // Should only have the string literal, not a comment range
    const texts = ranges.map(([s, e]) => sql.slice(s, e));
    expect(texts).toEqual(["'--'"]);
  });

  test("does not treat apostrophes inside comments as string starts", () => {
    const sql = "-- it's the user's filter\nSELECT * FROM t WHERE x = 'val'";
    const ranges = getProtectedRanges(sql);

    const texts = ranges.map(([s, e]) => sql.slice(s, e));
    expect(texts).toContain("-- it's the user's filter");
    expect(texts).toContain("'val'");
    expect(ranges).toHaveLength(2);
  });

  test("handles escaped quotes (doubled single quotes)", () => {
    const sql = "SELECT * FROM t WHERE name = 'it''s fine' AND id = :real";
    const ranges = getProtectedRanges(sql);

    const texts = ranges.map(([s, e]) => sql.slice(s, e));
    expect(texts).toEqual(["'it''s fine'"]);
  });
});

describe("substitution skips protected ranges", () => {
  test("does not substitute params inside string literals", () => {
    const sql = "SELECT * FROM t WHERE x = ':fake' AND y = :real";
    const ranges = getProtectedRanges(sql);
    const result = sql.replace(
      /:([a-zA-Z_]\w*)/g,
      (original, _paramName, offset) => {
        if (ranges.some(([s, e]) => offset >= s && offset < e)) {
          return original;
        }
        return "''";
      },
    );

    expect(result).toContain("':fake'");
    expect(result).toContain("y = ''");
    expect(result).not.toContain(":real");
  });

  test("does not substitute params inside comments", () => {
    const sql = "-- :skip_me\nSELECT * FROM t WHERE id = :keep";
    const ranges = getProtectedRanges(sql);
    const result = sql.replace(
      /:([a-zA-Z_]\w*)/g,
      (original, _paramName, offset) => {
        if (ranges.some(([s, e]) => offset >= s && offset < e)) {
          return original;
        }
        return "''";
      },
    );

    expect(result).toContain(":skip_me");
    expect(result).not.toContain(":keep");
    expect(result).toContain("id = ''");
  });
});
