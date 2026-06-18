import type { DatabricksStatementExecutionResponse } from "./types";

/**
 * Normalize a Statement Execution response so downstream parsers can always
 * read rows from `result.data_array`, regardless of the wire format the
 * warehouse chose.
 *
 * `@databricks/sdk-experimental`'s `executeStatement` defaults to an
 * `ARROW_STREAM` disposition. With an `INLINE` disposition the single
 * DESCRIBE row is returned as a base64-encoded Arrow IPC stream in
 * `result.attachment` and `result.data_array` is left undefined. The metric
 * and query type generators only ever read `result.data_array`, so without
 * this normalization an Arrow response reads as "returned no rows" — the
 * registry ships empty and the runtime fail-closed gate 503s every affected
 * metric/query. (A warehouse configured to return `JSON_ARRAY` populates
 * `data_array` directly and needs no decoding — that path, and every mocked
 * test, flows through here unchanged.)
 */
export async function normalizeResultRows(
  response: DatabricksStatementExecutionResponse,
): Promise<DatabricksStatementExecutionResponse> {
  // Truncation guard, above the passthrough so it runs on either transport. A
  // result exceeding INLINE's size limit is paginated (`next_chunk_*` set) and
  // we hold only the first chunk; emitting types from it would cache partial
  // types. A deliberate throw — unlike the best-effort decode below — that both
  // callers catch per-entry as a loud per-key/per-query failure.
  if (
    response.result?.next_chunk_index != null ||
    response.result?.next_chunk_internal_link != null
  ) {
    throw new Error(
      "DESCRIBE result is multi-chunk (truncated); refusing to emit partial types — see next_chunk_index",
    );
  }

  // Passthrough: rows already materialized (JSON_ARRAY warehouses + every
  // mocked test). `data_array` being an empty array still counts as present —
  // that is a genuine "no rows" answer we must not overwrite with a decode.
  if (response.result?.data_array !== undefined) {
    return response;
  }

  const attachment = response.result?.attachment;
  if (attachment === undefined) {
    // No rows, no attachment: let the downstream "no rows" degrade path fire.
    return response;
  }

  try {
    // Lazy import: only pull apache-arrow into the process when an attachment
    // genuinely needs decoding.
    const { tableFromIPC } = await import("apache-arrow");
    const bytes = Buffer.from(attachment, "base64");
    const table = tableFromIPC(bytes);
    // Extract each cell in SCHEMA/FIELD order. Spreading a StructRow
    // (`[...row]`) drives apache-arrow's StructRowIterator, which walks the
    // struct's children by positional index and yields `[fieldName, value]`
    // pairs in field order. We deliberately do NOT use `Object.values(row)`
    // nor `row.toArray()`: both funnel through `Object.values` (toArray() is
    // literally `Object.values(this.toJSON())` in apache-arrow@21), and
    // `Object.values` re-sorts integer-like keys ascending per the ECMAScript
    // spec — so an integer-named DESCRIBE column would scramble the positional
    // `[col_name, data_type, comment]` order. The iterator is immune to that.
    const dataArray: (string | null)[][] = table
      .toArray()
      .map((row) =>
        [...(row as Iterable<[unknown, unknown]>)].map(([, value]) =>
          value == null ? null : String(value),
        ),
      );

    return {
      ...response,
      result: {
        ...response.result,
        data_array: dataArray,
      },
    };
  } catch {
    // Best-effort: a corrupt/partial Arrow payload must not crash the pass.
    // Returning it unchanged routes into the deterministic "no rows" degrade.
    return response;
  }
}
