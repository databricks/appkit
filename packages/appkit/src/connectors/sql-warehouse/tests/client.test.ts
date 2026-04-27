import type { sql } from "@databricks/sdk-experimental";
import { Int64, Table, tableToIPC, vectorFromArray } from "apache-arrow";
import { describe, expect, it } from "vitest";
import { SQLWarehouseConnector } from "../client";

function arrowAttachment(table: Table): string {
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

function callTransform(
  client: SQLWarehouseConnector,
  response: sql.StatementResponse,
): sql.StatementResponse {
  // _transformDataArray is the private dispatcher we want to exercise; tests
  // intentionally reach in to validate the attachment-decoding path is wired.
  const fn = (
    client as unknown as {
      _transformDataArray: (r: sql.StatementResponse) => sql.StatementResponse;
    }
  )._transformDataArray.bind(client);
  return fn(response);
}

describe("SQLWarehouseConnector._transformDataArray (Arrow IPC attachment)", () => {
  const client = new SQLWarehouseConnector({});

  it("decodes inline ARROW_STREAM attachments and stringifies BigInt columns", () => {
    const table = new Table({
      id: vectorFromArray([1n, 2n], new Int64()),
      name: vectorFromArray(["alice", "bob"]),
      count: vectorFromArray([100n, 250n], new Int64()),
    });

    const response = {
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: arrowAttachment(table) },
    } as unknown as sql.StatementResponse;

    const out = callTransform(client, response) as unknown as {
      result: { data: Array<Record<string, unknown>>; attachment?: string };
    };

    expect(out.result.attachment).toBeUndefined();
    expect(out.result.data).toHaveLength(2);
    expect(out.result.data[0]).toEqual({
      id: "1",
      name: "alice",
      count: "100",
    });
    expect(out.result.data[1]).toEqual({ id: "2", name: "bob", count: "250" });

    // Crucial: the rows must round-trip through JSON without throwing.
    expect(() => JSON.stringify(out.result.data)).not.toThrow();
  });

  it("recursively stringifies BigInts inside list columns and unwraps Arrow Vectors", () => {
    // LIST<BIGINT> columns: apache-arrow infers the list child type from the
    // bigint elements, so this round-trips through IPC as List<Int64>.
    const table = new Table({
      ids: vectorFromArray([
        [1n, 2n, 3n],
        [4n, 5n],
      ]),
      label: vectorFromArray(["x", "y"]),
    });

    const response = {
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: arrowAttachment(table) },
    } as unknown as sql.StatementResponse;

    const out = callTransform(client, response) as unknown as {
      result: { data: Array<Record<string, unknown>> };
    };

    // Arrow Vector children must be flattened to plain arrays AND every nested
    // BigInt must be stringified so the row survives JSON.stringify.
    expect(out.result.data[0].ids).toEqual(["1", "2", "3"]);
    expect(out.result.data[1].ids).toEqual(["4", "5"]);
    expect(() => JSON.stringify(out.result.data)).not.toThrow();
  });

  it("falls through to the EXTERNAL_LINKS ARROW_STREAM branch when no attachment", () => {
    // No attachment, no data_array: legacy ARROW_STREAM path returns just
    // statement_id + status (chunks fetched separately via getArrowData).
    const response = {
      statement_id: "abc-123",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: {},
    } as unknown as sql.StatementResponse;

    const out = callTransform(client, response) as unknown as {
      result: { statement_id?: string; data?: unknown };
    };

    expect(out.result.statement_id).toBe("abc-123");
    expect(out.result.data).toBeUndefined();
  });

  it("throws ExecutionError on malformed Arrow IPC attachment", () => {
    const response = {
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: "this-is-not-valid-base64-arrow-ipc" },
    } as unknown as sql.StatementResponse;

    expect(() => callTransform(client, response)).toThrow(
      /Failed to decode Arrow IPC attachment/,
    );
  });

  it("preserves the legacy JSON_ARRAY (data_array) path unchanged", () => {
    const response = {
      manifest: {
        format: "JSON_ARRAY",
        schema: {
          columns: [
            { name: "id", type_name: "INT" },
            { name: "label", type_name: "STRING" },
          ],
        },
      },
      result: {
        data_array: [
          [1, "a"],
          [2, "b"],
        ],
      },
    } as unknown as sql.StatementResponse;

    const out = callTransform(client, response) as unknown as {
      result: { data: Array<Record<string, unknown>>; data_array?: unknown };
    };

    expect(out.result.data_array).toBeUndefined();
    expect(out.result.data).toEqual([
      { id: 1, label: "a" },
      { id: 2, label: "b" },
    ]);
  });
});
