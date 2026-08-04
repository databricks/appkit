import { type DataType, type Field, Type, tableFromIPC } from "apache-arrow";
import type { SQLTypeMarker } from "shared";
import { ExecutionError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { RefreshChunkLink } from "../../stream/arrow-stream-processor";
import type { sql } from "../../workspace-client";

/**
 * Centralized disposition/format fallback for analytics result delivery.
 *
 * Two warehouse capability profiles must both work, and their supported
 * combinations are mutually exclusive per warehouse:
 *
 * - **Reyden**: `ARROW_STREAM + INLINE` (and `JSON_ARRAY + INLINE`); does NOT
 *   support `EXTERNAL_LINKS`.
 * - **Normal SQL warehouse**: `JSON_ARRAY + INLINE` and
 *   `ARROW_STREAM + EXTERNAL_LINKS`; rejects `ARROW_STREAM + INLINE`.
 *
 * The fallback logic lives here (rather than inline in the plugin route) so it
 * can be unit-tested against a fake executor without HTTP, and so the brittle
 * "which rejection is this" decision is expressed once.
 */

const logger = createLogger("analytics:delivery");

/**
 * Minimal query surface the fallback needs. The analytics plugin (and its
 * `asUser(req)` proxy) satisfy it, so the same delivery logic runs unchanged
 * under service-principal and on-behalf-of identities.
 */
export interface QueryExecutor {
  query(
    query: string,
    parameters: Record<string, SQLTypeMarker | null | undefined> | undefined,
    formatParameters: { disposition: string; format: string },
    signal?: AbortSignal,
  ): Promise<
    | {
        attachment?: string;
        data?: Record<string, unknown>[];
        external_links?: sql.ExternalLink[];
        columnNames?: string[];
        statement_id?: string;
        status?: unknown;
        refreshChunkLink?: RefreshChunkLink;
      }
    | undefined
  >;
}

/** Streams already-resolved EXTERNAL_LINKS chunks; the connector provides it. */
export interface ArrowChunkStreamer {
  streamExternalLinks(
    chunks: sql.ExternalLink[],
    signal?: AbortSignal,
    refresh?: RefreshChunkLink,
  ): AsyncGenerator<Uint8Array, void, unknown>;
}

/** The arrow delivery mode a warehouse actually supports. */
export type ArrowCapability = "inline" | "external";

/** Optional per-warehouse capability memo, avoiding a doomed probe per query. */
interface ArrowDeliveryOptions {
  /**
   * When `"external"`, skip the `INLINE+ARROW_STREAM` attempt and go straight
   * to `EXTERNAL_LINKS` — a standard warehouse rejects INLINE arrow on every
   * query, so once we've learned that, the probe is pure waste. `"inline"` or
   * undefined attempts INLINE first (the common/Reyden path).
   */
  capabilityHint?: ArrowCapability;
  /**
   * Called once the working delivery mode is known, so the caller can memoize
   * it per warehouse for subsequent queries.
   */
  onCapabilityResolved?: (capability: ArrowCapability) => void;
}

/**
 * How a warehouse rejected a disposition/format combination.
 *
 * Only the two structured error codes Databricks emits for capability
 * mismatches (`INVALID_PARAMETER_VALUE`, `NOT_IMPLEMENTED`) gate a fallback —
 * auth, permission, and SQL errors never match, so they propagate untouched.
 * Message matching only *disambiguates* which capability is missing once the
 * code has confirmed it's a capability error.
 */
type DispositionRejection =
  | "needs-arrow-inline" // INLINE requires ARROW_STREAM
  | "needs-json-inline" // INLINE requires JSON_ARRAY
  | "external-links-unsupported" // EXTERNAL_LINKS not implemented
  | null;

/**
 * Whether an error is a disposition/format *capability* rejection — the only
 * class of error a fallback should react to. Gated on the two structured codes
 * Databricks emits for capability mismatches (`INVALID_PARAMETER_VALUE`,
 * `NOT_IMPLEMENTED`); auth, permission, and SQL errors carry other codes and
 * never match. This is deliberately message-independent: a Databricks wording
 * change must not turn a capability rejection into a hard 500.
 */
function isCapabilityRejection(err: unknown): boolean {
  const structuredCode =
    err instanceof ExecutionError ? err.errorCode : undefined;
  if (
    structuredCode === "INVALID_PARAMETER_VALUE" ||
    structuredCode === "NOT_IMPLEMENTED"
  ) {
    return true;
  }
  const lower = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    lower.includes("invalid_parameter_value") ||
    lower.includes("not_implemented")
  );
}

export function classifyDispositionRejection(
  err: unknown,
): DispositionRejection {
  // Auth / permission / SQL errors carry other codes → never fall back.
  if (!isCapabilityRejection(err)) return null;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // EXTERNAL_LINKS disposition not implemented (Reyden).
  if (
    /external[_\s]?links/.test(lower) &&
    (lower.includes("not yet implemented") ||
      lower.includes("not implemented") ||
      lower.includes("not supported"))
  ) {
    return "external-links-unsupported";
  }

  // Remaining cases are INLINE disposition/format mismatches.
  if (!lower.includes("inline")) return null;

  if (
    /only supports\s+arrow_stream/i.test(msg) ||
    /must be\s+arrow_stream/i.test(msg)
  ) {
    return "needs-arrow-inline";
  }
  if (
    /only supports\s+json_array/i.test(msg) ||
    /must be\s+json_array/i.test(msg) ||
    /arrow_stream\s+(is\s+|was\s+)?not\s+supported/i.test(msg)
  ) {
    return "needs-json-inline";
  }

  return null;
}

/** Structured error: the warehouse supports no Arrow delivery mode at all. */
export function arrowDeliveryUnsupported(): ExecutionError {
  return ExecutionError.statementFailed(
    "Warehouse supports neither ARROW_STREAM+INLINE nor ARROW_STREAM+EXTERNAL_LINKS",
    "ARROW_DELIVERY_UNSUPPORTED",
    'This warehouse cannot return Arrow results. Re-run the query with format="JSON_ARRAY".',
  );
}

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Produce the raw Arrow IPC bytes for an ARROW_STREAM query, applying the
 * capability fallback:
 *
 * 1. `INLINE + ARROW_STREAM` — on success the base64 attachment is decoded
 *    once and yielded as a `Uint8Array` view (no Arrow parsing, no stash).
 * 2. On a `needs-json-inline` rejection, `EXTERNAL_LINKS + ARROW_STREAM` —
 *    the pre-signed chunks resolved in the executor's own context are
 *    streamed one at a time.
 * 3. If EXTERNAL_LINKS is also unsupported, a structured
 *    `ARROW_DELIVERY_UNSUPPORTED` error is thrown.
 *
 * `out` is populated with the real column names and statement id before the
 * first chunk is yielded, so the caller can emit them (e.g. as a header)
 * ahead of the body.
 */
export async function* deliverArrowBytes(
  executor: QueryExecutor,
  streamer: ArrowChunkStreamer,
  query: string,
  processedParams: Record<string, SQLTypeMarker | null | undefined> | undefined,
  out: { columnNames?: string[]; statementId?: string },
  signal?: AbortSignal,
  opts?: ArrowDeliveryOptions,
): AsyncGenerator<Uint8Array, void, unknown> {
  // Skip the INLINE probe when a prior query already learned this warehouse
  // only serves arrow via EXTERNAL_LINKS (standard warehouses reject INLINE
  // arrow on every query, so probing each time is pure waste).
  if (opts?.capabilityHint !== "external") {
    try {
      const result = await executor.query(
        query,
        processedParams,
        { disposition: "INLINE", format: "ARROW_STREAM" },
        signal,
      );
      if (result?.attachment) {
        opts?.onCapabilityResolved?.("inline");
        out.columnNames = result.columnNames;
        out.statementId = result.statement_id;
        // Decode base64 once; yield a view over the Buffer (no copy, no parse).
        const decoded = Buffer.from(result.attachment, "base64");
        yield new Uint8Array(
          decoded.buffer,
          decoded.byteOffset,
          decoded.byteLength,
        );
        return;
      }
      // INLINE succeeded but returned no attachment (rare: inline data_array
      // under ARROW_STREAM). Fall through to EXTERNAL_LINKS.
      logger.warn(
        "ARROW_STREAM INLINE returned no attachment; falling back to EXTERNAL_LINKS",
      );
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      // Any capability-coded rejection of INLINE+ARROW_STREAM means this
      // warehouse won't serve arrow inline — try EXTERNAL_LINKS. We
      // intentionally do NOT require the message to match a specific phrase
      // ("must be JSON_ARRAY", …): the errorCode gate already excludes auth/SQL
      // errors, and relying on exact wording would turn a Databricks message
      // reword into a hard 500 on every standard warehouse. Worst case for a
      // genuinely bad parameter that happens to carry a capability code: one
      // wasted re-execution that fails identically on EXTERNAL_LINKS and
      // propagates.
      if (!isCapabilityRejection(err)) throw err;
      logger.warn(
        "ARROW_STREAM INLINE rejected by warehouse, falling back to EXTERNAL_LINKS: %s",
        errMessage(err),
      );
    }
  }

  let ext: Awaited<ReturnType<QueryExecutor["query"]>>;
  try {
    ext = await executor.query(
      query,
      processedParams,
      { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" },
      signal,
    );
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    // Neither INLINE nor EXTERNAL_LINKS Arrow is supported — surface a clear,
    // actionable error instead of a raw warehouse rejection.
    if (classifyDispositionRejection(err) === "external-links-unsupported") {
      throw arrowDeliveryUnsupported();
    }
    throw err;
  }

  if (!ext?.external_links) {
    throw ExecutionError.missingData("external_links");
  }
  opts?.onCapabilityResolved?.("external");
  out.columnNames = ext.columnNames;
  out.statementId = ext.statement_id;
  // Stream the pre-signed links resolved in THIS request's execution context
  // (user creds for `.obo.sql`, service principal otherwise). Pre-signed URLs
  // need no auth to download, so there is no second `getStatement` under a
  // mismatched identity. `refreshChunkLink` (also bound to this context) lets
  // the streamer re-mint a link that expires mid-download.
  yield* streamer.streamExternalLinks(
    ext.external_links,
    signal,
    ext.refreshChunkLink,
  );
}

/** JSON row result plus the metadata the SSE `result` message forwards. */
interface JsonResult {
  data: Record<string, unknown>[] | undefined;
  status: unknown;
  statement_id?: string;
}

/**
 * Produce JSON rows for a JSON_ARRAY query, applying the capability fallback:
 *
 * 1. `INLINE + JSON_ARRAY` — the native, common path.
 * 2. On a `needs-arrow-inline` rejection (warehouse only accepts ARROW_STREAM
 *    for INLINE, e.g. Reyden), retry `INLINE + ARROW_STREAM` and decode the
 *    attachment to plain rows server-side so the caller's JSON contract holds.
 *
 * EXTERNAL_LINKS is never used for the JSON fallback.
 */
export async function deliverJsonResult(
  executor: QueryExecutor,
  query: string,
  processedParams: Record<string, SQLTypeMarker | null | undefined> | undefined,
  signal?: AbortSignal,
): Promise<JsonResult> {
  try {
    const result = await executor.query(
      query,
      processedParams,
      { disposition: "INLINE", format: "JSON_ARRAY" },
      signal,
    );
    return {
      data: result?.data,
      status: result?.status,
      statement_id: result?.statement_id,
    };
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    if (classifyDispositionRejection(err) !== "needs-arrow-inline") throw err;
    logger.warn(
      "JSON_ARRAY INLINE rejected by warehouse, retrying as ARROW_STREAM INLINE and decoding server-side: %s",
      errMessage(err),
    );
  }

  const arrowResult = await executor.query(
    query,
    processedParams,
    { disposition: "INLINE", format: "ARROW_STREAM" },
    signal,
  );
  if (!arrowResult?.attachment) {
    throw ExecutionError.missingData("ARROW_STREAM attachment");
  }
  const rows = decodeArrowAttachmentToRows(
    arrowResult.attachment,
    arrowResult.columnNames,
  );
  return {
    data: rows,
    status: arrowResult.status,
    statement_id: arrowResult.statement_id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Server-side Arrow → JSON row materializer (JSON fallback only)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hard caps on the server-side JSON_ARRAY fallback. The materializer builds
 * every row as a plain JS object on the Node main thread (O(rows × cols)
 * allocations), so a runaway result blocks the event loop and pressures GC.
 * Cap on rows AND decoded bytes — either dimension can blow up independently.
 */
const JSON_ARRAY_FALLBACK_MAX_ROWS = 100_000;
const JSON_ARRAY_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

/** Render an apache-arrow Decimal cell to a fixed-point string. */
function formatDecimalCell(
  value: { toString(): string },
  scale: number,
): string {
  const unscaled = value.toString();
  if (scale <= 0) return unscaled;
  const negative = unscaled.startsWith("-");
  let digits = negative ? unscaled.slice(1) : unscaled;
  if (digits.length <= scale) digits = digits.padStart(scale + 1, "0");
  const point = digits.length - scale;
  const out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${out}` : out;
}

/**
 * Render an apache-arrow Timestamp cell to ISO-8601 ms precision — `Z` for
 * zoned columns, no `Z` for TIMESTAMP_NTZ — matching native JSON_ARRAY.
 */
function formatTimestampCell(epochMs: number, hasTimezone: boolean): string {
  const iso = new Date(epochMs).toISOString();
  return hasTimezone ? iso : iso.slice(0, -1);
}

/** Render an apache-arrow Date cell to `yyyy-MM-dd` (UTC). */
function formatDateCell(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Render a single scalar Arrow value to the string form the warehouse emits
 * under native JSON_ARRAY. Used for both top-level cells and (recursively, via
 * {@link renderNestedValue}) scalar leaves inside List/Struct/Map columns,
 * keyed on the Arrow field type so a nested `DECIMAL` keeps its scale and a
 * nested `TIMESTAMP` becomes ISO-8601 instead of raw epoch-ms.
 */
function formatScalarCell(value: unknown, type: DataType): string {
  switch (type.typeId) {
    case Type.Decimal:
      return formatDecimalCell(
        value as { toString(): string },
        (type as DataType & { scale: number }).scale,
      );
    case Type.Timestamp:
      return formatTimestampCell(
        Number(value),
        (type as DataType & { timezone?: string | null }).timezone != null,
      );
    case Type.Date:
      return formatDateCell(Number(value));
    default:
      if (value instanceof Uint8Array) {
        return Buffer.from(value).toString("base64");
      }
      if (value instanceof Date) return value.toISOString();
      return String(value);
  }
}

/**
 * Recursively render a nested Arrow value (List / Struct / Map, or a scalar
 * leaf) to the plain JS shape the warehouse nests inside a JSON_ARRAY cell:
 * structs and maps become objects, lists become arrays, and every scalar leaf
 * is stringified per {@link formatScalarCell}. The caller `JSON.stringify`s the
 * result so nested columns match the warehouse's native `data_array` exactly.
 */
function renderNestedValue(value: unknown, type: DataType): unknown {
  if (value == null) return null;
  switch (type.typeId) {
    case Type.List:
    case Type.FixedSizeList: {
      const itemType = (type as DataType & { children: Field[] }).children[0]
        .type;
      const out: unknown[] = [];
      for (const item of value as Iterable<unknown>) {
        out.push(renderNestedValue(item, itemType));
      }
      return out;
    }
    case Type.Struct: {
      const fields = (type as DataType & { children: Field[] }).children;
      const obj: Record<string, unknown> = {};
      for (const field of fields) {
        obj[field.name] = renderNestedValue(
          (value as Record<string, unknown>)[field.name],
          field.type,
        );
      }
      return obj;
    }
    case Type.Map: {
      // A Map is a List<Struct<key, value>>; the value child carries the type.
      const entriesType = (type as DataType & { children: Field[] }).children[0]
        .type;
      const valueType = (entriesType as DataType & { children: Field[] })
        .children[1].type;
      const obj: Record<string, unknown> = {};
      for (const [k, v] of value as Iterable<[unknown, unknown]>) {
        obj[String(k)] = renderNestedValue(v, valueType);
      }
      return obj;
    }
    default:
      return formatScalarCell(value, type);
  }
}

/** Parse a STRING cell that looks like JSON into an object/array. */
function maybeParseJsonString(value: string): unknown {
  if (value && (value[0] === "{" || value[0] === "[")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Decode a base64 Arrow IPC attachment to plain row objects, matching what the
 * warehouse emits natively under JSON_ARRAY so callers cannot tell which path
 * served the query.
 *
 * The output key uses the manifest name (`columnNames[i]`) when available —
 * Databricks encodes the Arrow schema positionally (col_0, …) — while the
 * vector is still fetched by the Arrow field's own name.
 */
export function decodeArrowAttachmentToRows(
  attachment: string,
  columnNames?: string[],
): Record<string, unknown>[] {
  const decoded = Buffer.from(attachment, "base64");
  if (decoded.byteLength > JSON_ARRAY_FALLBACK_MAX_BYTES) {
    throw ExecutionError.statementFailed(
      `Result attachment is ${decoded.byteLength} bytes; JSON_ARRAY fallback materializer caps at ${JSON_ARRAY_FALLBACK_MAX_BYTES} bytes. Re-issue the query with format="ARROW_STREAM" to stream the full result.`,
      "RESULT_TOO_LARGE_FOR_JSON_FALLBACK",
      "Result too large for JSON format. Re-run with ARROW_STREAM format.",
    );
  }
  const table = tableFromIPC(
    new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength),
  );
  if (table.numRows > JSON_ARRAY_FALLBACK_MAX_ROWS) {
    throw ExecutionError.statementFailed(
      `Result has ${table.numRows} rows; JSON_ARRAY fallback materializer caps at ${JSON_ARRAY_FALLBACK_MAX_ROWS}. Re-issue the query with format="ARROW_STREAM" to stream the full result.`,
      "RESULT_TOO_LARGE_FOR_JSON_FALLBACK",
      `Result too large for JSON format (over ${JSON_ARRAY_FALLBACK_MAX_ROWS} rows). Re-run with ARROW_STREAM format.`,
    );
  }
  // Resolve child vectors once (getChild walks fields on every call). The
  // output key uses the manifest name; the vector is fetched by field name.
  const columns = table.schema.fields.map((f, i) => {
    const outName =
      columnNames?.[i] && columnNames[i].length > 0 ? columnNames[i] : f.name;
    return [outName, table.getChild(f.name), f.type] as const;
  });
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const [name, col, type] of columns) {
      const v = col?.get(i);
      if (v == null) {
        row[name] = null;
        continue;
      }
      switch (type.typeId) {
        case Type.Decimal:
        case Type.Timestamp:
        case Type.Date:
          row[name] = formatScalarCell(v, type);
          continue;
        // Nested columns (STRUCT / ARRAY / MAP) arrive on the native
        // JSON_ARRAY wire as a JSON string with every scalar leaf stringified
        // by type; render the same shape and stringify so callers cannot tell
        // the fallback path from the native one.
        case Type.List:
        case Type.FixedSizeList:
        case Type.Struct:
        case Type.Map:
          row[name] = JSON.stringify(renderNestedValue(v, type));
          continue;
      }
      if (
        typeof v === "number" ||
        typeof v === "bigint" ||
        typeof v === "boolean"
      ) {
        row[name] = String(v);
      } else if (typeof v === "string") {
        row[name] = maybeParseJsonString(v);
      } else if (v instanceof Uint8Array) {
        row[name] = Buffer.from(v).toString("base64");
      } else {
        row[name] = formatScalarCell(v, type);
      }
    }
    rows.push(row);
  }
  return rows;
}
