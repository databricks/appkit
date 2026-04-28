import type { sql } from "@databricks/sdk-experimental";
import { tableFromIPC } from "apache-arrow";
import { describe, expect, test, vi } from "vitest";

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

// Real base64 Arrow IPC from a serverless warehouse returning
// `SELECT 1 AS test_col, 2 AS test_col2` with INLINE + ARROW_STREAM.
// Contains schema (two INT columns) + one record batch with values [1, 2].
const REAL_ARROW_ATTACHMENT =
  "/////7gAAAAQAAAAAAAKAAwACgAJAAQACgAAABAAAAAAAQQACAAIAAAABAAIAAAABAAAAAIAAABMAAAABAAAAMz///8QAAAAGAAAAAAAAQIUAAAAvP///yAAAAAAAAABAAAAAAkAAAB0ZXN0X2NvbDIAAAAQABQAEAAOAA8ABAAAAAgAEAAAABgAAAAgAAAAAAABAhwAAAAIAAwABAALAAgAAAAgAAAAAAAAAQAAAAAIAAAAdGVzdF9jb2wAAAAA/////7gAAAAQAAAADAAaABgAFwAEAAgADAAAACAAAAAAAQAAAAAAAAAAAAAAAAADBAAKABgADAAIAAQACgAAADwAAAAQAAAAAQAAAAAAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAEAAAAAAAAAQAAAAAAAAAAEAAAAAAAAAIAAAAAAAAAAAQAAAAAAAADAAAAAAAAAAAQAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP////8AAAAA";

describe("SQLWarehouseConnector._transformDataArray", () => {
  describe("classic warehouse (JSON_ARRAY + INLINE)", () => {
    test("transforms data_array rows into named objects", () => {
      const connector = createConnector();
      // Real response shape from classic warehouse: INLINE + JSON_ARRAY
      const response = {
        statement_id: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "JSON_ARRAY",
          schema: {
            column_count: 2,
            columns: [
              {
                name: "test_col",
                type_text: "INT",
                type_name: "INT",
                position: 0,
              },
              {
                name: "test_col2",
                type_text: "INT",
                type_name: "INT",
                position: 1,
              },
            ],
          },
          total_row_count: 1,
          truncated: false,
        },
        result: {
          data_array: [["1", "2"]],
        },
      } as unknown as sql.StatementResponse;

      const result = (connector as any)._transformDataArray(response);
      expect(result.result.data).toEqual([{ test_col: "1", test_col2: "2" }]);
      expect(result.result.data_array).toBeUndefined();
    });

    test("parses JSON strings in STRING columns", () => {
      const connector = createConnector();
      const response = {
        statement_id: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "JSON_ARRAY",
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
  });

  describe("classic warehouse (EXTERNAL_LINKS + ARROW_STREAM)", () => {
    test("returns statement_id for external links fetch", () => {
      const connector = createConnector();
      // Real response shape from classic warehouse: EXTERNAL_LINKS + ARROW_STREAM
      const response = {
        statement_id: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "test_col", type_name: "INT" },
              { name: "test_col2", type_name: "INT" },
            ],
          },
        },
        result: {
          external_links: [
            {
              external_link: "https://storage.example.com/chunk0",
              expiration: "2026-04-15T00:00:00Z",
            },
          ],
        },
      } as unknown as sql.StatementResponse;

      const result = (connector as any)._transformDataArray(response);
      expect(result.result.statement_id).toBe("stmt-1");
      expect(result.result.data).toBeUndefined();
    });
  });

  describe("serverless warehouse (INLINE + ARROW_STREAM with attachment)", () => {
    test("passes attachment through unchanged for client-side decoding", () => {
      const connector = createConnector();
      // Real response shape from serverless warehouse: INLINE + ARROW_STREAM
      // Data arrives in result.attachment as base64-encoded Arrow IPC, not data_array.
      const response = {
        statement_id: "00000001-test-stmt",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            column_count: 2,
            columns: [
              {
                name: "test_col",
                type_text: "INT",
                type_name: "INT",
                position: 0,
              },
              {
                name: "test_col2",
                type_text: "INT",
                type_name: "INT",
                position: 1,
              },
            ],
            total_chunk_count: 1,
            chunks: [{ chunk_index: 0, row_offset: 0, row_count: 1 }],
            total_row_count: 1,
          },
          truncated: false,
        },
        result: {
          chunk_index: 0,
          row_offset: 0,
          row_count: 1,
          attachment: REAL_ARROW_ATTACHMENT,
        },
      } as unknown as sql.StatementResponse;

      const result = (connector as any)._transformDataArray(response);
      expect(result.result.attachment).toBe(REAL_ARROW_ATTACHMENT);
      expect(result.result.data).toBeUndefined();
      // Preserves other result fields
      expect(result.result.row_count).toBe(1);
    });

    test("preserves manifest and status alongside attachment", () => {
      const connector = createConnector();
      const response = {
        statement_id: "00000001-test-stmt",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "test_col", type_name: "INT" },
              { name: "test_col2", type_name: "INT" },
            ],
          },
        },
        result: {
          chunk_index: 0,
          row_count: 1,
          attachment: REAL_ARROW_ATTACHMENT,
        },
      } as unknown as sql.StatementResponse;

      const result = (connector as any)._transformDataArray(response);
      // Manifest, statement_id, and attachment are all preserved
      expect(result.manifest.format).toBe("ARROW_STREAM");
      expect(result.statement_id).toBe("00000001-test-stmt");
      expect(result.result.attachment).toBe(REAL_ARROW_ATTACHMENT);
    });

    test("synthesizes an empty Arrow IPC attachment for empty results so the client always gets a Table", () => {
      const connector = createConnector();
      // Empty result: no attachment, no data_array, no external_links — but
      // the manifest still describes the schema. The connector should fill in
      // `attachment` with a zero-row Arrow IPC matching the schema.
      const response = {
        statement_id: "stmt-empty",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "user_id", type_text: "BIGINT", type_name: "BIGINT" },
              { name: "name", type_text: "STRING", type_name: "STRING" },
              {
                name: "balance",
                type_text: "DECIMAL(10,2)",
                type_name: "DECIMAL",
              },
            ],
          },
          total_row_count: 0,
        },
        result: {},
      } as unknown as sql.StatementResponse;

      const transformed = (connector as any)._transformDataArray(response);
      const attachment: string = transformed.result.attachment;
      expect(typeof attachment).toBe("string");
      expect(attachment.length).toBeGreaterThan(0);

      // Verify the synthesized attachment decodes into the right empty schema.
      const table = tableFromIPC(Buffer.from(attachment, "base64"));
      expect(table.numRows).toBe(0);
      expect(table.schema.fields.map((f) => f.name)).toEqual([
        "user_id",
        "name",
        "balance",
      ]);
    });

    test("does NOT synthesize an attachment when external_links are present", () => {
      const connector = createConnector();
      const response = {
        statement_id: "stmt-ext",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: { columns: [{ name: "x", type_text: "INT" }] },
        },
        result: {
          external_links: [
            { external_link: "https://example.com/x", expiration: "9999" },
          ],
        },
      } as unknown as sql.StatementResponse;

      const transformed = (connector as any)._transformDataArray(response);
      // External-links path returns the statement_id projection — no attachment.
      expect(transformed.result.attachment).toBeUndefined();
      expect(transformed.result.statement_id).toBe("stmt-ext");
    });

    test("does NOT synthesize an attachment when schema is missing", () => {
      const connector = createConnector();
      const response = {
        statement_id: "stmt-no-schema",
        status: { state: "SUCCEEDED" },
        manifest: { format: "ARROW_STREAM" },
        result: {},
      } as unknown as sql.StatementResponse;

      const transformed = (connector as any)._transformDataArray(response);
      // Without a schema we cannot build a Table — pass through unchanged.
      expect(transformed.result?.attachment).toBeUndefined();
    });

    test("rejects oversized attachments to bound memory", () => {
      const connector = createConnector();
      // 25 MiB decoded cap → ~36 MiB of base64 chars decodes to >25 MiB.
      const oversized = "A".repeat(36 * 1024 * 1024);
      const response = {
        statement_id: "stmt-oversized",
        status: { state: "SUCCEEDED" },
        manifest: { format: "ARROW_STREAM" },
        result: { attachment: oversized },
      } as unknown as sql.StatementResponse;

      expect(() => (connector as any)._transformDataArray(response)).toThrow(
        /exceeds maximum size/,
      );
    });
  });

  describe("ARROW_STREAM with data_array (hypothetical inline variant)", () => {
    test("transforms data_array like JSON_ARRAY path", () => {
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
    });
  });

  describe("edge cases", () => {
    test("returns response unchanged when no data_array, attachment, or schema", () => {
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

    test("attachment takes priority over data_array when both present", () => {
      const connector = createConnector();
      const response = {
        statement_id: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "test_col", type_name: "INT" },
              { name: "test_col2", type_name: "INT" },
            ],
          },
        },
        result: {
          attachment: REAL_ARROW_ATTACHMENT,
          data_array: [["999", "999"]],
        },
      } as unknown as sql.StatementResponse;

      const result = (connector as any)._transformDataArray(response);
      // Should pass attachment through (client decodes), not transform data_array
      expect(result.result.attachment).toBe(REAL_ARROW_ATTACHMENT);
      expect(result.result.data).toBeUndefined();
    });
  });
});
