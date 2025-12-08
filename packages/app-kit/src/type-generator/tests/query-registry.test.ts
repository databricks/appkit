import { describe, expect, test } from "vitest";
import {
  convertToQueryType,
  extractParameters,
  extractParameterTypes,
  SERVER_INJECTED_PARAMS,
} from "../query-registry";
import type { DatabricksStatementExecutionResponse } from "../types";

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

describe("convertToQueryType", () => {
  const mockResponse: DatabricksStatementExecutionResponse = {
    statement_id: "test-123",
    status: { state: "SUCCEEDED" },
    manifest: {
      schema: {
        column_count: 3,
        columns: [
          { name: "id", type_text: "STRING", type_name: "STRING", position: 0 },
          {
            name: "name",
            type_text: "STRING",
            type_name: "STRING",
            position: 1,
          },
          { name: "count", type_text: "INT", type_name: "INT", position: 2 },
        ],
      },
    },
  };

  test("generates query type with parameters", () => {
    const sql = "SELECT * FROM users WHERE start_date = :startDate";
    const result = convertToQueryType(mockResponse, sql, "users");

    expect(result).toContain('name: "users"');
    expect(result).toContain("parameters:");
    expect(result).toContain("startDate: SQLTypeMarker");
    expect(result).toContain("result: Array<{");
  });

  test("excludes server-injected params from parameters type", () => {
    const sql =
      "SELECT * FROM users WHERE workspace_id = :workspaceId AND date = :startDate";
    const result = convertToQueryType(mockResponse, sql, "users");

    expect(result).toContain("startDate: SQLTypeMarker");
    expect(result).not.toContain("workspaceId:");
  });

  test("uses specific marker types when @param annotation is provided", () => {
    const sql = `-- @param startDate DATE
-- @param count NUMERIC
-- @param name STRING
SELECT * FROM users WHERE date = :startDate AND count = :count AND name = :name`;
    const result = convertToQueryType(mockResponse, sql, "users");

    expect(result).toContain("startDate: SQLDateMarker");
    expect(result).toContain("count: SQLNumberMarker");
    expect(result).toContain("name: SQLStringMarker");
  });

  test("generates Record<string, never> for queries without params", () => {
    const sql = "SELECT * FROM users";
    const result = convertToQueryType(mockResponse, sql, "users");

    expect(result).toContain("parameters: Record<string, never>");
  });

  test("maps column types correctly", () => {
    const result = convertToQueryType(mockResponse, "SELECT 1", "test");

    expect(result).toContain("id: string");
    expect(result).toContain("name: string");
    expect(result).toContain("count: number");
  });

  test("adds JSDoc comments with @sqlType", () => {
    const result = convertToQueryType(mockResponse, "SELECT 1", "test");

    expect(result).toContain("/** @sqlType STRING */");
    expect(result).toContain("/** @sqlType INT */");
  });

  test("uses column comment when available", () => {
    const responseWithComment: DatabricksStatementExecutionResponse = {
      ...mockResponse,
      manifest: {
        schema: {
          column_count: 1,
          columns: [
            {
              name: "total",
              type_text: "DECIMAL",
              type_name: "DECIMAL",
              position: 0,
              comment: "Total amount in USD",
            },
          ],
        },
      },
    };

    const result = convertToQueryType(responseWithComment, "SELECT 1", "test");

    expect(result).toContain("/** Total amount in USD */");
  });

  test("quotes invalid column identifiers", () => {
    const responseWithInvalidName: DatabricksStatementExecutionResponse = {
      ...mockResponse,
      manifest: {
        schema: {
          column_count: 1,
          columns: [
            {
              name: "(1 = 1)",
              type_text: "BOOLEAN",
              type_name: "BOOLEAN",
              position: 0,
            },
          ],
        },
      },
    };

    const result = convertToQueryType(
      responseWithInvalidName,
      "SELECT 1",
      "test",
    );

    expect(result).toContain('"(1 = 1)": boolean');
  });
});
