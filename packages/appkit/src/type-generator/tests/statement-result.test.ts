import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeResultRows } from "../statement-result";
import type { DatabricksStatementExecutionResponse } from "../types";

/**
 * Real Arrow IPC attachment captured live from dogfood:
 *   DESCRIBE TABLE EXTENDED `appkit_demo`.`public`.`revenue_metrics` AS JSON
 * run with `format: "ARROW_STREAM", disposition: "INLINE"`. The single
 * DESCRIBE row (one JSON-string cell) is encoded as base64 Arrow IPC — exactly
 * what `executeStatement` returns by default and what the silent-degrade bug
 * left unread. Committing the bytes keeps the decoder tested offline and
 * deterministically.
 */
const ARROW_ATTACHMENT_B64 = fs.readFileSync(
  path.join(__dirname, "fixtures", "describe-arrow-attachment.b64"),
  "utf-8",
);

/**
 * Synthetic Arrow IPC attachment whose struct field NAMES are integer-like and
 * deliberately out of ascending order ("2","0","1"), carrying the values
 * ["revenue", "DOUBLE", "total revenue"] in that field order. It exists to
 * prove the decoder extracts cells in SCHEMA/FIELD order rather than by sorted
 * key: `Object.values(row)` / `row.toArray()` (which apache-arrow implements as
 * `Object.values(this.toJSON())`) would re-sort the integer keys to "0","1","2"
 * and emit ["DOUBLE","total revenue","revenue"] — scrambling the positional
 * [col_name, data_type, comment] triple. The `[...row]` iterator we use is
 * immune. Generated offline via apache-arrow `tableToIPC` (low-level Field[]
 * construction; the high-level builders re-sort integer keys at build time).
 */
const ARROW_REORDERED_FIELDS_B64 = fs.readFileSync(
  path.join(__dirname, "fixtures", "describe-arrow-reordered-fields.b64"),
  "utf-8",
);

describe("normalizeResultRows", () => {
  test("decodes an Arrow attachment into data_array (real fixture)", async () => {
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-arrow",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: ARROW_ATTACHMENT_B64 },
    };

    const normalized = await normalizeResultRows(response);

    // One row, one cell — the JSON-string DESCRIBE payload.
    expect(normalized.result?.data_array).toHaveLength(1);
    expect(normalized.result?.data_array?.[0]).toHaveLength(1);

    const cell = normalized.result?.data_array?.[0]?.[0];
    expect(typeof cell).toBe("string");

    // The real describe doc parses to an object with a non-empty `columns` array.
    const parsed = JSON.parse(cell as string) as { columns: unknown[] };
    expect(Array.isArray(parsed.columns)).toBe(true);
    expect(parsed.columns.length).toBeGreaterThan(0);
  });

  test("preserves status, statement_id, and manifest when decoding", async () => {
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-arrow",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: ARROW_ATTACHMENT_B64 },
    };

    const normalized = await normalizeResultRows(response);

    expect(normalized.statement_id).toBe("stmt-arrow");
    expect(normalized.status.state).toBe("SUCCEEDED");
    expect(normalized.manifest?.format).toBe("ARROW_STREAM");
    // The attachment is left in place; only data_array is added.
    expect(normalized.result?.attachment).toBe(ARROW_ATTACHMENT_B64);
  });

  test("passes through unchanged when data_array is already present", async () => {
    // JSON_ARRAY warehouses (and every mocked test) take this path: no decode.
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-json",
      status: { state: "SUCCEEDED" },
      manifest: { format: "JSON_ARRAY" },
      result: { data_array: [['{"columns":[]}']] },
    };

    const normalized = await normalizeResultRows(response);

    expect(normalized).toBe(response);
    expect(normalized.result?.data_array).toEqual([['{"columns":[]}']]);
  });

  test("treats an empty data_array as present (genuine no-rows, no decode)", async () => {
    // An empty array is a real "no rows" answer — it must not be overwritten by
    // an attachment decode even if an attachment is somehow also present.
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-empty",
      status: { state: "SUCCEEDED" },
      result: { data_array: [], attachment: ARROW_ATTACHMENT_B64 },
    };

    const normalized = await normalizeResultRows(response);

    expect(normalized).toBe(response);
    expect(normalized.result?.data_array).toEqual([]);
  });

  test("returns response unchanged when neither data_array nor attachment is present", async () => {
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-bare",
      status: { state: "SUCCEEDED" },
      result: {},
    };

    const normalized = await normalizeResultRows(response);

    expect(normalized).toBe(response);
    expect(normalized.result?.data_array).toBeUndefined();
  });

  test("returns response unchanged when result is entirely absent", async () => {
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-noresult",
      status: { state: "RUNNING" },
    };

    const normalized = await normalizeResultRows(response);

    expect(normalized).toBe(response);
    expect(normalized.result).toBeUndefined();
  });

  test("does not throw when Arrow decoding rejects; degrades to no usable rows", async () => {
    // Bytes that look like an Arrow IPC header but aren't make `tableFromIPC`
    // throw. The decoder must swallow that so the generation pass does not
    // crash — it leaves data_array absent and the downstream "returned no
    // rows" degrade fires instead.
    const notArrow = Buffer.from(
      "hello world this is plainly not an arrow ipc stream",
    ).toString("base64");
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-corrupt",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: notArrow },
    };

    let normalized!: DatabricksStatementExecutionResponse;
    await expect(
      (async () => {
        normalized = await normalizeResultRows(response);
      })(),
    ).resolves.toBeUndefined();

    // No fabricated rows: decode rejected, so data_array stays absent.
    expect(normalized.result?.data_array).toBeUndefined();
    // The (bad) attachment is preserved; nothing was invented.
    expect(normalized.result?.attachment).toBe(notArrow);
  });

  test("decodes garbage that yields an empty Arrow table to an empty data_array", async () => {
    // Some malformed payloads decode without throwing into a zero-row table
    // (e.g. truncated/garbage bytes). That surfaces as an empty data_array —
    // which is itself a valid "no rows" answer and degrades correctly
    // downstream, never a fabricated row.
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-garbage",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: "not-valid-base64-arrow-ipc!!!" },
    };

    const normalized = await normalizeResultRows(response);

    // Either absent or empty — both mean "no usable rows". Crucially: no
    // non-empty fabricated row.
    expect(normalized.result?.data_array ?? []).toHaveLength(0);
  });

  test("throws on a multi-chunk result flagged by next_chunk_index", async () => {
    // A DESCRIBE result that exceeds INLINE's size limit is paginated. The
    // first chunk carries `next_chunk_index`; decoding it alone would silently
    // cache partial types. The normalizer must throw (loud) rather than degrade
    // — distinct from the malformed-attachment path which degrades silently.
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-chunked-json",
      status: { state: "SUCCEEDED" },
      manifest: { format: "JSON_ARRAY" },
      // data_array present (first chunk) — but the guard runs ABOVE the
      // passthrough, so truncation still throws instead of returning rows.
      result: {
        data_array: [["col_a", "STRING", null]],
        next_chunk_index: 1,
      },
    };

    await expect(normalizeResultRows(response)).rejects.toThrow(/multi-chunk/i);
    await expect(normalizeResultRows(response)).rejects.toThrow(
      /next_chunk_index/,
    );
  });

  test("throws on a multi-chunk result flagged by next_chunk_internal_link", async () => {
    // The attachment transport can paginate too: first chunk arrives as an
    // Arrow attachment with `next_chunk_internal_link` set. The guard runs
    // before the decode, so this throws rather than emitting first-chunk types.
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-chunked-arrow",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: {
        attachment: ARROW_ATTACHMENT_B64,
        next_chunk_internal_link:
          "/api/2.0/sql/statements/stmt/result/chunks/1",
      },
    };

    await expect(normalizeResultRows(response)).rejects.toThrow(/multi-chunk/i);
  });

  test("throws on a multi-chunk result with neither data_array nor attachment", async () => {
    // Even when the first chunk somehow carries no inline rows, the chunk
    // markers alone mean the answer is truncated — refuse, do not fall through
    // to the "no rows" degrade.
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-chunked-bare",
      status: { state: "SUCCEEDED" },
      result: { next_chunk_index: 2 },
    };

    await expect(normalizeResultRows(response)).rejects.toThrow(
      /refusing to emit partial types/i,
    );
  });

  test("extracts decoded cells in schema/field order, not sorted-key order", async () => {
    // Regression guard for the positional extraction. The fixture's struct has
    // integer-like field names out of ascending order ("2","0","1"). The old
    // `Object.values(row)` (and apache-arrow's own `row.toArray()`) would
    // re-sort those keys and emit ["DOUBLE","total revenue","revenue"],
    // scrambling the [col_name, data_type, comment] triple. The `[...row]`
    // iterator preserves field order.
    const response: DatabricksStatementExecutionResponse = {
      statement_id: "stmt-reordered",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM" },
      result: { attachment: ARROW_REORDERED_FIELDS_B64 },
    };

    const normalized = await normalizeResultRows(response);

    expect(normalized.result?.data_array).toEqual([
      ["revenue", "DOUBLE", "total revenue"],
    ]);
  });
});
