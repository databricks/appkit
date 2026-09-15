import { tableFromIPC } from "apache-arrow";
import { describe, expect, test, vi } from "vitest";

import type {
  ExternalLink,
  StatementResponse,
} from "../../../workspace-client";

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

// `_transformDataArray` is async — it paginates multi-chunk EXTERNAL_LINKS
// results. The workspace client is only touched when following
// `nextChunkIndex`, so a bare stub suffices for the inline / JSON /
// single-chunk cases; the multi-chunk tests pass a real mock.
function transform(
  connector: SQLWarehouseConnector,
  response: StatementResponse,
  workspaceClient: unknown = {},
) {
  return (connector as any)._transformDataArray(response, workspaceClient);
}

// Real base64 Arrow IPC from a serverless warehouse returning
// `SELECT 1 AS test_col, 2 AS test_col2` with INLINE + ARROW_STREAM.
// Contains schema (two INT columns) + one record batch with values [1, 2].
const REAL_ARROW_ATTACHMENT =
  "/////7gAAAAQAAAAAAAKAAwACgAJAAQACgAAABAAAAAAAQQACAAIAAAABAAIAAAABAAAAAIAAABMAAAABAAAAMz///8QAAAAGAAAAAAAAQIUAAAAvP///yAAAAAAAAABAAAAAAkAAAB0ZXN0X2NvbDIAAAAQABQAEAAOAA8ABAAAAAgAEAAAABgAAAAgAAAAAAABAhwAAAAIAAwABAALAAgAAAAgAAAAAAAAAQAAAAAIAAAAdGVzdF9jb2wAAAAA/////7gAAAAQAAAADAAaABgAFwAEAAgADAAAACAAAAAAAQAAAAAAAAAAAAAAAAADBAAKABgADAAIAAQACgAAADwAAAAQAAAAAQAAAAAAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAEAAAAAAAAAQAAAAAAAAAAEAAAAAAAAAIAAAAAAAAAAAQAAAAAAAADAAAAAAAAAAAQAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP////8AAAAA";

describe("SQLWarehouseConnector._transformDataArray", () => {
  describe("classic warehouse (JSON_ARRAY + INLINE)", () => {
    test("transforms dataArray rows into named objects", async () => {
      const connector = createConnector();
      // Real response shape from classic warehouse: INLINE + JSON_ARRAY
      const response = {
        statementId: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "JSON_ARRAY",
          schema: {
            column_count: 2,
            columns: [
              {
                name: "test_col",
                typeText: "INT",
                typeName: "INT",
                position: 0,
              },
              {
                name: "test_col2",
                typeText: "INT",
                typeName: "INT",
                position: 1,
              },
            ],
          },
          total_row_count: 1,
          truncated: false,
        },
        result: {
          dataArray: [["1", "2"]],
        },
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      expect(result.result.data).toEqual([{ test_col: "1", test_col2: "2" }]);
      expect(result.result.dataArray).toBeUndefined();
    });

    test("parses JSON strings in STRING columns", async () => {
      const connector = createConnector();
      const response = {
        statementId: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "JSON_ARRAY",
          schema: {
            columns: [
              { name: "id", typeName: "INT" },
              { name: "metadata", typeName: "STRING" },
            ],
          },
        },
        result: {
          dataArray: [["1", '{"key":"value"}']],
        },
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      expect(result.result.data[0].metadata).toEqual({ key: "value" });
    });
  });

  describe("classic warehouse (EXTERNAL_LINKS + ARROW_STREAM)", () => {
    test("returns statement_id for external links fetch", async () => {
      const connector = createConnector();
      // Real response shape from classic warehouse: EXTERNAL_LINKS + ARROW_STREAM
      const response = {
        statementId: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "test_col", typeName: "INT" },
              { name: "test_col2", typeName: "INT" },
            ],
          },
        },
        result: {
          externalLinks: [
            {
              externalLink: "https://storage.example.com/chunk0",
              expiration: "2026-04-15T00:00:00Z",
            },
          ],
        },
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      expect(result.result.statement_id).toBe("stmt-1");
      expect(result.result.data).toBeUndefined();
    });
  });

  describe("serverless warehouse (INLINE + ARROW_STREAM with attachment)", () => {
    test("passes attachment through unchanged for client-side decoding", async () => {
      const connector = createConnector();
      // Real response shape from serverless warehouse: INLINE + ARROW_STREAM
      // Data arrives in result.attachment as base64-encoded Arrow IPC, not dataArray.
      const response = {
        statementId: "00000001-test-stmt",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            column_count: 2,
            columns: [
              {
                name: "test_col",
                typeText: "INT",
                typeName: "INT",
                position: 0,
              },
              {
                name: "test_col2",
                typeText: "INT",
                typeName: "INT",
                position: 1,
              },
            ],
            totalChunkCount: 1,
            chunks: [{ chunkIndex: 0, row_offset: 0, row_count: 1 }],
            total_row_count: 1,
          },
          truncated: false,
        },
        result: {
          chunkIndex: 0,
          row_offset: 0,
          row_count: 1,
          attachment: REAL_ARROW_ATTACHMENT,
        },
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      expect(result.result.attachment).toBe(REAL_ARROW_ATTACHMENT);
      expect(result.result.data).toBeUndefined();
      // Preserves other result fields
      expect(result.result.row_count).toBe(1);
      // `statement_id` is projected onto the result so the route can advertise
      // an `X-Appkit-Arrow-Columns-Ref` for wide inline schemas (it lives on
      // the top-level response, not on `ResultData`).
      expect(result.result.statement_id).toBe("00000001-test-stmt");
    });

    test("preserves manifest and status alongside attachment", async () => {
      const connector = createConnector();
      const response = {
        statementId: "00000001-test-stmt",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "test_col", typeName: "INT" },
              { name: "test_col2", typeName: "INT" },
            ],
          },
        },
        result: {
          chunkIndex: 0,
          row_count: 1,
          attachment: REAL_ARROW_ATTACHMENT,
        },
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      // Manifest, statement_id, and attachment are all preserved
      expect(result.manifest.format).toBe("ARROW_STREAM");
      expect(result.statementId).toBe("00000001-test-stmt");
      expect(result.result.attachment).toBe(REAL_ARROW_ATTACHMENT);
    });

    test("synthesizes an empty Arrow IPC attachment for empty results so the client always gets a Table", async () => {
      const connector = createConnector();
      // Empty result: no attachment, no dataArray, no external_links — but
      // the manifest still describes the schema. The connector should fill in
      // `attachment` with a zero-row Arrow IPC matching the schema.
      const response = {
        statementId: "stmt-empty",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "user_id", typeText: "BIGINT", typeName: "BIGINT" },
              { name: "name", typeText: "STRING", typeName: "STRING" },
              {
                name: "balance",
                typeText: "DECIMAL(10,2)",
                typeName: "DECIMAL",
              },
            ],
          },
          total_row_count: 0,
        },
        result: {},
      } as unknown as StatementResponse;

      const transformed = await transform(connector, response);
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

    test("does NOT synthesize an attachment when external_links are present", async () => {
      const connector = createConnector();
      const response = {
        statementId: "stmt-ext",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: { columns: [{ name: "x", typeText: "INT" }] },
        },
        result: {
          externalLinks: [
            { externalLink: "https://example.com/x", expiration: "9999" },
          ],
        },
      } as unknown as StatementResponse;

      const transformed = await transform(connector, response);
      // External-links path returns the statement_id projection — no attachment.
      expect(transformed.result.attachment).toBeUndefined();
      expect(transformed.result.statement_id).toBe("stmt-ext");
    });

    test("empty external_links array is a zero-row result → synthesizes an empty table (not the streaming path)", async () => {
      const connector = createConnector();
      // Some warehouses emit `externalLinks: []` for a zero-row result rather
      // than omitting it. An empty array must NOT go down the streaming path
      // (streamChunks([]) rejects) — synthesize an empty Arrow table instead.
      const response = {
        statementId: "stmt-empty-ext",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [{ name: "x", typeText: "INT", typeName: "INT" }],
          },
          total_row_count: 0,
        },
        result: { externalLinks: [] },
      } as unknown as StatementResponse;

      const transformed = await transform(connector, response);
      const attachment: string = transformed.result.attachment;
      expect(typeof attachment).toBe("string");
      const table = tableFromIPC(Buffer.from(attachment, "base64"));
      expect(table.numRows).toBe(0);
      expect(table.schema.fields.map((f) => f.name)).toEqual(["x"]);
    });

    test("does NOT synthesize an attachment when schema is missing", async () => {
      const connector = createConnector();
      const response = {
        statementId: "stmt-no-schema",
        status: { state: "SUCCEEDED" },
        manifest: { format: "ARROW_STREAM" },
        result: {},
      } as unknown as StatementResponse;

      const transformed = await transform(connector, response);
      // Without a schema we cannot build a Table — pass through unchanged.
      expect(transformed.result?.attachment).toBeUndefined();
    });

    test("rejects oversized attachments to bound memory", async () => {
      const connector = createConnector();
      // 25 MiB decoded cap (Databricks API hard cap on INLINE) → 36 MiB of
      // base64 chars decodes to ~27 MiB, comfortably above the limit.
      const oversized = "A".repeat(36 * 1024 * 1024);
      const response = {
        statementId: "stmt-oversized",
        status: { state: "SUCCEEDED" },
        manifest: { format: "ARROW_STREAM" },
        result: { attachment: oversized },
      } as unknown as StatementResponse;

      await expect(transform(connector, response)).rejects.toThrow(
        /exceeds maximum size/,
      );
    });
  });

  describe("ARROW_STREAM with dataArray (hypothetical inline variant)", () => {
    test("transforms dataArray like JSON_ARRAY path", async () => {
      const connector = createConnector();
      const response = {
        statementId: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "id", typeName: "INT" },
              { name: "value", typeName: "STRING" },
            ],
          },
        },
        result: {
          dataArray: [
            ["1", "hello"],
            ["2", "world"],
          ],
        },
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      expect(result.result.data).toEqual([
        { id: "1", value: "hello" },
        { id: "2", value: "world" },
      ]);
    });
  });

  describe("edge cases", () => {
    test("returns response unchanged when no dataArray, attachment, or schema", async () => {
      const connector = createConnector();
      const response = {
        statementId: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: { format: "JSON_ARRAY" },
        result: {},
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      expect(result).toBe(response);
    });

    test("attachment takes priority over dataArray when both present", async () => {
      const connector = createConnector();
      const response = {
        statementId: "stmt-1",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          schema: {
            columns: [
              { name: "test_col", typeName: "INT" },
              { name: "test_col2", typeName: "INT" },
            ],
          },
        },
        result: {
          attachment: REAL_ARROW_ATTACHMENT,
          dataArray: [["999", "999"]],
        },
      } as unknown as StatementResponse;

      const result = await transform(connector, response);
      // Should pass attachment through (client decodes), not transform dataArray
      expect(result.result.attachment).toBe(REAL_ARROW_ATTACHMENT);
      expect(result.result.data).toBeUndefined();
    });
  });

  describe("multi-chunk EXTERNAL_LINKS pagination", () => {
    function multiChunkResponse(totalChunks: number): StatementResponse {
      return {
        statementId: "stmt-multi",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "ARROW_STREAM",
          totalChunkCount: totalChunks,
          schema: { columns: [{ name: "x", typeName: "INT" }] },
        },
        result: {
          externalLinks: [
            {
              chunkIndex: 0,
              externalLink: "https://example.com/chunk0",
              nextChunkIndex: 1,
            },
          ],
        },
      } as unknown as StatementResponse;
    }

    test("follows nextChunkIndex to resolve every chunk's links", async () => {
      const connector = createConnector();
      const getResultData = vi
        .fn()
        .mockResolvedValueOnce({
          externalLinks: [
            {
              chunkIndex: 1,
              externalLink: "https://example.com/chunk1",
              nextChunkIndex: 2,
            },
          ],
        })
        .mockResolvedValueOnce({
          externalLinks: [
            { chunkIndex: 2, externalLink: "https://example.com/chunk2" },
          ],
        });
      const workspaceClient = {
        statementExecution: { getResultData },
      };

      const result = await transform(
        connector,
        multiChunkResponse(3),
        workspaceClient,
      );

      expect(getResultData).toHaveBeenCalledTimes(2);
      expect(getResultData).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ statementId: "stmt-multi", chunkIndex: 1 }),
        expect.anything(),
      );
      expect(
        result.result.external_links.map((l: ExternalLink) => l.externalLink),
      ).toEqual([
        "https://example.com/chunk0",
        "https://example.com/chunk1",
        "https://example.com/chunk2",
      ]);
    });

    test("is bounded by totalChunkCount when nextChunkIndex never terminates", async () => {
      const connector = createConnector();
      // Misbehaving warehouse: always advertises another chunk.
      const getResultData = vi.fn().mockResolvedValue({
        externalLinks: [
          {
            chunkIndex: 1,
            externalLink: "https://example.com/loop",
            nextChunkIndex: 99,
          },
        ],
      });
      const workspaceClient = {
        statementExecution: { getResultData },
      };

      const result = await transform(
        connector,
        multiChunkResponse(2),
        workspaceClient,
      );

      // Terminates (no hang) — capped at totalChunkCount fetches.
      expect(getResultData).toHaveBeenCalledTimes(2);
      expect(result.result.external_links.length).toBeGreaterThan(0);
    });
  });
});
