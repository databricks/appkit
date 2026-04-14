import type { sql } from "@databricks/sdk-experimental";
import { describe, expect, test, vi } from "vitest";

// Mock all transitive dependencies to isolate _transformDataArray logic.
vi.mock("../../../telemetry", () => {
  const mockMeter = {
    createCounter: () => ({ add: vi.fn() }),
    createHistogram: () => ({ record: vi.fn() }),
  };
  return {
    TelemetryManager: {
      getProvider: () => ({
        startActiveSpan: vi.fn(),
        getMeter: () => mockMeter,
      }),
    },
    SpanKind: { CLIENT: 1 },
    SpanStatusCode: { ERROR: 2 },
  };
});
vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: () => null,
  }),
}));
vi.mock("../../../stream/arrow-stream-processor", () => ({
  ArrowStreamProcessor: vi.fn(),
}));

import { SQLWarehouseConnector } from "../client";

function createConnector() {
  return new SQLWarehouseConnector({ timeout: 30000 });
}

describe("SQLWarehouseConnector._transformDataArray", () => {
  test("transforms ARROW_STREAM + INLINE data_array into named objects", () => {
    const connector = createConnector();
    const response = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: {
        format: "ARROW_STREAM",
        schema: {
          columns: [
            { name: "id", type_name: "INT" },
            { name: "value", type_name: "STRING" },
          ],
        },
      },
      result: {
        data_array: [
          ["1", "hello"],
          ["2", "world"],
        ],
      },
    } as unknown as sql.StatementResponse;

    const result = (connector as any)._transformDataArray(response);
    expect(result.result.data).toEqual([
      { id: "1", value: "hello" },
      { id: "2", value: "world" },
    ]);
    expect(result.result.data_array).toBeUndefined();
  });

  test("returns statement_id for ARROW_STREAM + EXTERNAL_LINKS (no data_array)", () => {
    const connector = createConnector();
    const response = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: {
        external_links: [
          { external_link: "https://storage.example.com/chunk0" },
        ],
      },
    } as unknown as sql.StatementResponse;

    const result = (connector as any)._transformDataArray(response);
    expect(result.result.statement_id).toBe("stmt-1");
    expect(result.result.data).toBeUndefined();
  });

  test("transforms JSON_ARRAY data_array into named objects", () => {
    const connector = createConnector();
    const response = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: {
        format: "JSON_ARRAY",
        schema: {
          columns: [
            { name: "name", type_name: "STRING" },
            { name: "count", type_name: "INT" },
          ],
        },
      },
      result: {
        data_array: [
          ["Alice", "10"],
          ["Bob", "20"],
        ],
      },
    } as unknown as sql.StatementResponse;

    const result = (connector as any)._transformDataArray(response);
    expect(result.result.data).toEqual([
      { name: "Alice", count: "10" },
      { name: "Bob", count: "20" },
    ]);
  });

  test("parses JSON strings in STRING columns for ARROW_STREAM + INLINE", () => {
    const connector = createConnector();
    const response = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: {
        format: "ARROW_STREAM",
        schema: {
          columns: [
            { name: "id", type_name: "INT" },
            { name: "metadata", type_name: "STRING" },
          ],
        },
      },
      result: {
        data_array: [["1", '{"key":"value"}']],
      },
    } as unknown as sql.StatementResponse;

    const result = (connector as any)._transformDataArray(response);
    expect(result.result.data[0].metadata).toEqual({ key: "value" });
  });

  test("returns response unchanged when no data_array or schema", () => {
    const connector = createConnector();
    const response = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: { format: "JSON_ARRAY" },
      result: {},
    } as unknown as sql.StatementResponse;

    const result = (connector as any)._transformDataArray(response);
    expect(result).toBe(response);
  });
});
