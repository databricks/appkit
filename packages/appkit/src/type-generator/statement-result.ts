import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../logging/logger";
import { getErrorMessage } from "./errors";
import type { DatabricksStatementExecutionResponse } from "./types";

const logger = createLogger("type-generator:statement-result");

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
  } catch (err) {
    // Best-effort: a corrupt/partial Arrow payload — or a missing apache-arrow
    // module — must not crash the pass. Warn so a Reyden user whose decode failed
    // gets a breadcrumb instead of mysteriously-empty types, then return the
    // response unchanged: it routes into the deterministic "no rows" degrade.
    logger.warn(
      "failed to decode ARROW_STREAM DESCRIBE attachment (%s); emitting no rows — metric/query types may degrade",
      getErrorMessage(err),
    );
    return response;
  }
}

/** Result format the typegen requests for a DESCRIBE. */
type DescribeFormat = "JSON_ARRAY" | "ARROW_STREAM";

/**
 * Per-path memo of the result format a warehouse accepts for a DESCRIBE shape.
 * Create one per describe path (metric / query) and reuse it across that path's
 * statements: a typegen run targets a single warehouse, so the working format
 * is discovered once and every later DESCRIBE skips the probe. NOT shared
 * across paths — `DESCRIBE QUERY` and `DESCRIBE … AS JSON` can differ (Reyden
 * fails `JSON_ARRAY` only for the single-cell `AS JSON` result).
 */
export interface DescribeFormatMemo {
  format?: "JSON_ARRAY" | "ARROW_STREAM";
}

/**
 * True when a failure means the warehouse REJECTED the requested result format
 * (so another format is worth trying), not that it ran the statement and hit a
 * real error. There is no structured signal for this, so we match the two known
 * server signatures: Reyden's `merge_json_arrays` (its `JSON_ARRAY` assembly
 * fails on a `… AS JSON` single-cell result) and standard DBSQL's rejection of
 * `ARROW_STREAM` under an `INLINE` disposition. A genuine SQL error,
 * connectivity failure, or not-ready warehouse does NOT match — those are
 * returned/propagated for the caller's normal handling, never re-tried.
 */
function isFormatRejection(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("merge_json_arrays") ||
    m.includes("must be json_array") ||
    (m.includes("disposition") && m.includes("format"))
  );
}

/**
 * Run a DESCRIBE and return a response whose rows are readable via
 * `result.data_array`, adapting to the warehouse's result-format capability.
 *
 * No single format is portable: standard DBSQL (PRO/CLASSIC) serves
 * `INLINE`+`JSON_ARRAY` and rejects `INLINE`+`ARROW_STREAM`; the Reyden engine
 * is the inverse — it rejects `JSON_ARRAY` on a `… AS JSON` result
 * (`merge_json_arrays`) and only returns rows as an `INLINE`+`ARROW_STREAM`
 * attachment. We try `JSON_ARRAY` first (the documented default) and ONLY when
 * the warehouse rejects that format ({@link isFormatRejection}) fall back to
 * `ARROW_STREAM` (decoded by {@link normalizeResultRows}); the accepted format
 * is memoized so the rest of the run skips the probe. Any other outcome —
 * success, SQL error, degrade, connectivity failure — is returned or propagated
 * unchanged, exactly as a single executeStatement would.
 */
export async function describeAdaptive(
  client: WorkspaceClient,
  statement: string,
  warehouseId: string,
  memo: DescribeFormatMemo,
): Promise<DatabricksStatementExecutionResponse> {
  const formats: DescribeFormat[] = memo.format
    ? [memo.format]
    : ["JSON_ARRAY", "ARROW_STREAM"];
  let lastResponse: DatabricksStatementExecutionResponse | undefined;
  let lastError: unknown;
  for (const format of formats) {
    try {
      const response = (await client.statementExecution.executeStatement({
        statement,
        warehouse_id: warehouseId,
        // Synchronous wait: without it the call can return PENDING/RUNNING with
        // no rows, which downstream misreads as a no-result degrade.
        wait_timeout: "30s",
        format,
        disposition: "INLINE",
      })) as DatabricksStatementExecutionResponse;
      const normalized = await normalizeResultRows(response);
      if (
        normalized.status?.state === "FAILED" &&
        isFormatRejection(normalized.status.error?.message)
      ) {
        lastResponse = normalized;
        continue; // warehouse rejected this format — try the next
      }
      if (normalized.status?.state === "SUCCEEDED") {
        memo.format = format;
      }
      return normalized;
    } catch (error) {
      if (isFormatRejection(getErrorMessage(error))) {
        lastError = error;
        continue; // format rejected via a thrown error — try the next
      }
      throw error;
    }
  }
  // Every attempted format was rejected. Surface the last outcome so the caller
  // degrades / reports as usual.
  if (lastResponse !== undefined) return lastResponse;
  throw lastError;
}
