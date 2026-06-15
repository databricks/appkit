import type { DatabricksStatementExecutionResponse } from "./types";

/**
 * Normalize a Statement Execution response so downstream parsers can always
 * read rows from `result.data_array`, regardless of the wire format the
 * warehouse chose.
 *
 * ## Why this exists
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
 *
 * ## Behavior
 *
 * - `data_array` already present → return the response unchanged (passthrough;
 *   keeps JSON_ARRAY warehouses and all `data_array`-based mocked tests working
 *   with zero decode cost).
 * - otherwise `attachment` present → lazily import `apache-arrow`, decode the
 *   IPC stream, and return a response with `result.data_array` populated as
 *   `(string | null)[][]`. All other fields (`status`, `statement_id`,
 *   `manifest`, and any other `result` keys) are preserved.
 * - neither present → return the response unchanged (empty result; the
 *   downstream "returned no rows" path then degrades correctly).
 *
 * ## Failure contract
 *
 * Two distinct paths, by design:
 *
 * - **Truncation throws (loud).** A multi-chunk result (`next_chunk_index`
 *   and/or `next_chunk_internal_link` set) means the warehouse split the rows
 *   across chunks and we only hold the first. Emitting types from a partial
 *   DESCRIBE would silently cache wrong/incomplete types, so this case
 *   **throws** before any passthrough or decode. Both callers run their
 *   describe inside a per-entry try / `Promise.allSettled`, so the throw
 *   surfaces as a loud per-key/per-query failure (a non-transient
 *   `MetricSyncFailure` / a fatal query error), never an uncaught crash.
 * - **Malformed/empty attachment degrades (never throws).** Decode is
 *   best-effort: a corrupt/empty attachment resolves to the original response
 *   (with `data_array` still absent) rather than rejecting. The metric/query
 *   sync paths treat a response without rows as a deterministic "no rows"
 *   degrade (warn-and-continue + sticky cache), so swallowing the decode error
 *   here keeps that contract intact instead of crashing the whole generation
 *   pass on one bad payload.
 *
 * The `apache-arrow` import is lazy (dynamic `import()`) so the dependency only
 * loads when an attachment actually needs decoding — JSON_ARRAY warehouses and
 * unit tests that build `data_array` directly never pull it in.
 *
 * @param response - the raw Statement Execution response
 * @returns a response guaranteed to expose rows via `result.data_array` when
 *   they were decodable, otherwise the response unchanged
 */
export async function normalizeResultRows(
  response: DatabricksStatementExecutionResponse,
): Promise<DatabricksStatementExecutionResponse> {
  // Truncation guard (ABOVE the passthrough — runs on EITHER transport).
  // A DESCRIBE result that exceeds INLINE's size limit is paginated: the
  // warehouse sets `next_chunk_index` and/or `next_chunk_internal_link` and we
  // only hold the FIRST chunk's rows (whether those rows arrived in
  // `data_array` or as an Arrow `attachment`). Decoding just the first chunk
  // would silently cache partial types, so we refuse here. This is a
  // DELIBERATE throw — distinct from the best-effort decode below, which still
  // degrades-never-throws on a malformed attachment. Both callers wrap this in
  // a per-entry catch, so the throw becomes a loud per-key/per-query failure.
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
    // No rows, no attachment: nothing to normalize. Let the downstream
    // "returned no rows" degrade path fire.
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
    // Best-effort: a corrupt/partial Arrow payload must not crash the
    // generation pass. Returning the response unchanged (data_array still
    // absent) routes it into the deterministic "no rows" degrade downstream.
    return response;
  }
}
