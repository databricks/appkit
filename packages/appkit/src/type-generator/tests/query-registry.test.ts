import { Table, tableToIPC, vectorFromArray } from "apache-arrow";
import { describe, expect, test, vi } from "vitest";

const { mockLoggerWarn, mockLoggerDebug } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));
vi.mock("../../logging/logger", () => ({
  createLogger: vi.fn(() => ({
    debug: mockLoggerDebug,
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    event: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      setComponent: vi.fn().mockReturnThis(),
      setContext: vi.fn().mockReturnThis(),
    })),
  })),
}));

import {
  convertToQueryType,
  defaultForType,
  extractParameterDefaults,
  extractParameters,
  extractParameterTypes,
  getProtectedRanges,
  inferParameterTypes,
  normalizeTypeName,
  SERVER_INJECTED_PARAMS,
  substituteParametersForDescribe,
} from "../query-registry";
import type { DatabricksStatementExecutionResponse } from "../types";

// Build a base64 Arrow IPC payload that mimics a DESCRIBE QUERY response —
// a result *table* with columns (col_name, data_type, comment) describing
// the user query's output schema.
function describeQueryAttachment(
  rows: Array<{ col_name: string; data_type: string; comment: string | null }>,
): string {
  const table = new Table({
    col_name: vectorFromArray(rows.map((r) => r.col_name)),
    data_type: vectorFromArray(rows.map((r) => r.data_type)),
    comment: vectorFromArray(rows.map((r) => r.comment ?? "")),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

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
-- @param dec DECIMAL
-- @param i INT
-- @param big BIGINT
-- @param tiny TINYINT
-- @param small SMALLINT
-- @param f FLOAT
-- @param d DOUBLE
-- @param bool BOOLEAN
-- @param dt DATE
-- @param ts TIMESTAMP
-- @param tsNtz TIMESTAMP_NTZ
-- @param bin BINARY
SELECT 1`;
    const types = extractParameterTypes(sql);

    expect(types.str).toBe("STRING");
    expect(types.num).toBe("NUMERIC");
    expect(types.dec).toBe("DECIMAL");
    expect(types.i).toBe("INT");
    expect(types.big).toBe("BIGINT");
    expect(types.tiny).toBe("TINYINT");
    expect(types.small).toBe("SMALLINT");
    expect(types.f).toBe("FLOAT");
    expect(types.d).toBe("DOUBLE");
    expect(types.bool).toBe("BOOLEAN");
    expect(types.dt).toBe("DATE");
    expect(types.ts).toBe("TIMESTAMP");
    expect(types.tsNtz).toBe("TIMESTAMP_NTZ");
    expect(types.bin).toBe("BINARY");
  });

  test("TIMESTAMP_NTZ is not partially matched as TIMESTAMP", () => {
    // Regression: the alternation TIMESTAMP_NTZ must come before TIMESTAMP
    // (and end with a word boundary) so the regex engine doesn't capture
    // `TIMESTAMP` and leave `_NTZ` unconsumed.
    const sql = `-- @param eventTs TIMESTAMP_NTZ
SELECT 1`;
    const types = extractParameterTypes(sql);
    expect(types.eventTs).toBe("TIMESTAMP_NTZ");
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

  test("returns '0' for integer aliases (INT/BIGINT/TINYINT/SMALLINT/DECIMAL)", () => {
    expect(defaultForType("INT")).toBe("0");
    expect(defaultForType("BIGINT")).toBe("0");
    expect(defaultForType("TINYINT")).toBe("0");
    expect(defaultForType("SMALLINT")).toBe("0");
    expect(defaultForType("DECIMAL")).toBe("0");
  });

  test("returns '0.0' for FLOAT and DOUBLE", () => {
    expect(defaultForType("FLOAT")).toBe("0.0");
    expect(defaultForType("DOUBLE")).toBe("0.0");
  });

  test("returns NTZ-shaped literal for TIMESTAMP_NTZ", () => {
    expect(defaultForType("TIMESTAMP_NTZ")).toBe("'2000-01-01T00:00:00'");
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

  describe("ARROW_STREAM attachment fallback (serverless warehouses)", () => {
    test("decodes column metadata from Arrow IPC data rows, not schema fields", () => {
      // Critical regression test: it would be a bug to read
      // `table.schema.fields` here, which would generate types like
      // { col_name: string; data_type: string; comment: string } for every
      // query (those are DESCRIBE QUERY's own output columns). We must read
      // the data rows.
      const attachment = describeQueryAttachment([
        { col_name: "user_id", data_type: "BIGINT", comment: null },
        { col_name: "name", data_type: "STRING", comment: "display name" },
        { col_name: "active", data_type: "BOOLEAN", comment: null },
      ]);
      const response: DatabricksStatementExecutionResponse = {
        statement_id: "test-arrow",
        status: { state: "SUCCEEDED" },
        result: { attachment },
      };

      const { type, hasResults } = convertToQueryType(
        response,
        "SELECT user_id, name, active FROM users",
        "users",
      );

      expect(hasResults).toBe(true);
      // Real query columns appear in the generated type:
      expect(type).toContain("user_id: number");
      expect(type).toContain("name: string");
      expect(type).toContain("active: boolean");
      // Column comments survive:
      expect(type).toContain("/** display name");
      // The DESCRIBE QUERY metadata column names must NOT leak as user types:
      expect(type).not.toContain("col_name: string");
      expect(type).not.toContain("data_type: string");
    });

    test("normalizes lowercase data_type values to uppercase", () => {
      const attachment = describeQueryAttachment([
        { col_name: "id", data_type: "int", comment: null },
      ]);
      const response: DatabricksStatementExecutionResponse = {
        statement_id: "test-arrow",
        status: { state: "SUCCEEDED" },
        result: { attachment },
      };

      const { type } = convertToQueryType(response, "SELECT 1", "test");
      expect(type).toContain("@sqlType INT");
      expect(type).toContain("id: number");
    });

    test("prefers data_array over attachment when both are present", () => {
      const attachment = describeQueryAttachment([
        { col_name: "from_arrow", data_type: "STRING", comment: null },
      ]);
      const response: DatabricksStatementExecutionResponse = {
        statement_id: "test-both",
        status: { state: "SUCCEEDED" },
        result: {
          data_array: [["from_data_array", "INT", null]],
          attachment,
        },
      };

      const { type } = convertToQueryType(response, "SELECT 1", "test");
      expect(type).toContain("from_data_array: number");
      expect(type).not.toContain("from_arrow");
    });

    test("logs a warning and yields the unknown-result fallback on malformed attachment", () => {
      mockLoggerWarn.mockClear();
      const response: DatabricksStatementExecutionResponse = {
        statement_id: "test-bad",
        status: { state: "SUCCEEDED" },
        result: { attachment: "not-valid-arrow-ipc" },
      };

      const { hasResults, type } = convertToQueryType(
        response,
        "SELECT 1",
        "test",
      );

      // No columns extracted → unknown-result type, hasResults false.
      expect(hasResults).toBe(false);
      expect(type).toContain("unknown");
      // None of DESCRIBE QUERY's metadata column names should leak in as
      // user-facing type fields — that would mean the parser swallowed
      // the failure and produced bogus columns instead.
      expect(type).not.toContain("col_name");
      expect(type).not.toContain("data_type");

      // The warning must fire so a regression that silently produces empty
      // types (no telemetry signal) fails this test.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to decode Arrow IPC attachment"),
        expect.any(String),
      );
    });
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

describe("extractParameterDefaults", () => {
  test("returns empty object when no sample values are present", () => {
    const sql =
      "-- @param startDate DATE\nSELECT * FROM t WHERE d = :startDate";
    expect(extractParameterDefaults(sql)).toEqual({});
  });

  test("quotes string-like sample values", () => {
    const sql = [
      "-- @param target_catalog STRING = main",
      "-- @param since DATE = 2024-01-01",
      "SELECT 1",
    ].join("\n");
    expect(extractParameterDefaults(sql)).toEqual({
      target_catalog: "'main'",
      since: "'2024-01-01'",
    });
  });

  test("passes numeric and boolean sample values through verbatim", () => {
    const sql = [
      "-- @param limit INT = 100",
      "-- @param ratio DOUBLE = 0.5",
      "-- @param active BOOLEAN = true",
      "SELECT 1",
    ].join("\n");
    expect(extractParameterDefaults(sql)).toEqual({
      limit: "100",
      ratio: "0.5",
      active: "true",
    });
  });

  test("leaves already-quoted values untouched and escapes embedded quotes", () => {
    const sql = [
      "-- @param a STRING = 'pre-quoted'",
      "-- @param b STRING = O'Brien",
      "SELECT 1",
    ].join("\n");
    expect(extractParameterDefaults(sql)).toEqual({
      a: "'pre-quoted'",
      b: "'O''Brien'",
    });
  });

  test("ignores @param lines without a value", () => {
    const sql = "-- @param onlyType STRING\nSELECT 1";
    expect(extractParameterDefaults(sql)).toEqual({});
  });

  test("rejects numeric sample values that aren't plain numbers (no injection)", () => {
    const sql = [
      "-- @param n INT = 0) UNION SELECT secret FROM creds --",
      "-- @param r DOUBLE = 1; DROP TABLE x",
      "SELECT 1",
    ].join("\n");
    // Both fail strict numeric validation and are dropped (not substituted),
    // so they fall back to the safe type default during DESCRIBE.
    expect(extractParameterDefaults(sql)).toEqual({});
  });

  test("rejects non-boolean BOOLEAN sample values", () => {
    const sql = "-- @param flag BOOLEAN = 1 OR 1=1\nSELECT 1";
    expect(extractParameterDefaults(sql)).toEqual({});
  });

  test("accepts well-formed BINARY and rejects malformed BINARY", () => {
    expect(
      extractParameterDefaults("-- @param b BINARY = X'00'\nSELECT 1"),
    ).toEqual({ b: "X'00'" });
    expect(
      extractParameterDefaults("-- @param b BINARY = X'00' OR 1=1\nSELECT 1"),
    ).toEqual({});
  });

  test("neutralizes a string value that isn't a well-formed literal by escaping it", () => {
    const sql = ["-- @param x STRING = 'a' OR 1=1 OR 'b'", "SELECT 1"].join(
      "\n",
    );
    // The lone interior quotes mean this isn't a single well-formed literal, so
    // it's treated as raw content and fully escaped — one inert string literal,
    // no SQL break-out.
    expect(extractParameterDefaults(sql)).toEqual({
      x: "'''a'' OR 1=1 OR ''b'''",
    });
  });

  test("escapes backslashes so a string value can't break out via \\'", () => {
    // Databricks/Spark treats `\` as an escape inside string literals, so
    // doubling only `'` is not enough: `x\' UNION ...` quoted as `'x\'' ...'`
    // would let `\'` escape the first quote and the next `'` close the literal,
    // turning the rest into executable SQL. Escaping `\` -> `\\` first keeps the
    // value as one inert literal.
    const sql = [
      "-- @param x STRING = x\\' UNION SELECT secret FROM creds --",
      "SELECT 1",
    ].join("\n");
    expect(extractParameterDefaults(sql)).toEqual({
      x: "'x\\\\'' UNION SELECT secret FROM creds --'",
    });
    // A backslash-bearing "looks pre-quoted" value is not trusted either: it is
    // re-escaped rather than passed through (an unterminated `'a\'`).
    expect(
      extractParameterDefaults("-- @param y STRING = 'a\\'\nSELECT 1"),
    ).toEqual({ y: "'''a\\\\'''" });
  });

  test("a value-less `=` line does not swallow the following line", () => {
    // `\s` would match the newline and capture the next line as the value; the
    // horizontal-only whitespace class makes this line simply not match, so the
    // param falls back to its type placeholder during DESCRIBE.
    const blankValue = ["-- @param target_catalog STRING =", "SELECT 1"].join(
      "\n",
    );
    expect(extractParameterDefaults(blankValue)).toEqual({});

    // ...and it must not consume the *next* @param annotation either.
    const blankThenNext = [
      "-- @param a STRING =",
      "-- @param b INT = 5",
      "SELECT 1",
    ].join("\n");
    expect(extractParameterDefaults(blankThenNext)).toEqual({ b: "5" });
  });
});

describe("substituteParametersForDescribe (IDENTIFIER support, #383)", () => {
  test("empty-string default produces malformed SQL for IDENTIFIER params", () => {
    // Reproduces the bug: with no sample value, an untyped IDENTIFIER param
    // collapses to '' and yields IDENTIFIER('' || '.schema.table'), a leading-dot
    // identifier that Databricks rejects with PARSE_SYNTAX_ERROR.
    const sql = "SELECT * FROM IDENTIFIER(:target_catalog || '.sales.nation')";
    expect(substituteParametersForDescribe(sql)).toBe(
      "SELECT * FROM IDENTIFIER('' || '.sales.nation')",
    );
  });

  test("sample value resolves IDENTIFIER to a real, describable table", () => {
    const sql = [
      "-- @param target_catalog STRING = main",
      "SELECT * FROM IDENTIFIER(:target_catalog || '.sales.nation')",
    ].join("\n");
    const out = substituteParametersForDescribe(sql);
    expect(out).toContain("IDENTIFIER('main' || '.sales.nation')");
    expect(out).not.toContain(":target_catalog");
  });

  test("sample value wins over the type-based default", () => {
    const sql = [
      "-- @param status STRING = active",
      "SELECT * FROM t WHERE status = :status",
    ].join("\n");
    expect(substituteParametersForDescribe(sql)).toContain("status = 'active'");
  });

  test("falls back to the type default when no sample value is given", () => {
    const sql = ["-- @param limit INT", "SELECT * FROM t LIMIT :limit"].join(
      "\n",
    );
    expect(substituteParametersForDescribe(sql)).toBe(
      "-- @param limit INT\nSELECT * FROM t LIMIT 0",
    );
  });

  test("does not substitute placeholders inside string literals", () => {
    const sql = "SELECT ':target_catalog' AS lit, :target_catalog AS p";
    const sql2 = ["-- @param target_catalog STRING = main", sql].join("\n");
    const out = substituteParametersForDescribe(sql2);
    expect(out).toContain("':target_catalog' AS lit");
    expect(out).toContain("'main' AS p");
  });

  test("rejects an injection attempt in a numeric param, falling back to the placeholder", () => {
    const sql = [
      "-- @param n INT = 1); DROP TABLE x --",
      "SELECT * FROM t LIMIT :n",
    ].join("\n");
    const out = substituteParametersForDescribe(sql);
    // The malicious value is dropped; :n falls back to the INT default 0, so the
    // payload never reaches the executable LIMIT clause. (It survives only in the
    // @param comment line, which is inert.)
    expect(out).toContain("SELECT * FROM t LIMIT 0");
    expect(out).not.toContain(":n");
    expect(out).not.toContain("LIMIT 1)");
  });
});
