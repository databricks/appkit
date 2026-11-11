import { type DataType, type Field, Type, tableFromIPC } from "apache-arrow";
import type { SQLTypeMarker } from "shared";

import { MAX_INLINE_ATTACHMENT_BYTES } from "../../connectors/sql-warehouse/defaults";
import { formatJsonArrayCell } from "../../connectors/sql-warehouse/json-array-cells";
import { ExecutionError } from "../../errors";
import { createLogger } from "../../logging/logger";
import {
  asDownloadFailure,
  type RefreshChunkLink,
} from "../../stream/arrow-stream-processor";
import type { ExternalLink } from "../../workspace-client";

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
    formatParameters: {
      disposition: string;
      format: string;
      asArrow?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        attachment?: string;
        data?: Record<string, unknown>[];
        external_links?: ExternalLink[];
        columnNames?: string[];
        totalByteCount?: number;
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
    chunks: ExternalLink[],
    signal?: AbortSignal,
    refresh?: RefreshChunkLink,
    fullHeaderWait?: boolean,
  ): AsyncGenerator<Uint8Array, void, unknown>;
}

/**
 * The arrow delivery mode a warehouse actually supports. `"links-denied"`:
 * storage refused or never answered Cloud Fetch, so inline `JSON_ARRAY` goes first.
 */
export type ArrowCapability = "inline" | "external" | "links-denied";

/** Filled in before the first byte, so the route can send them as headers. */
export interface ArrowDeliveryOut {
  columnNames?: string[];
  statementId?: string;
}

/** What {@link deliverArrowBytes} leaves for the fallback to retry a Cloud Fetch download with. */
interface DeliveryState extends ArrowDeliveryOut {
  cloudFetch?: {
    totalByteCount?: number;
    stream(fullHeaderWait: boolean): AsyncGenerator<Uint8Array, void, unknown>;
  };
}

export const LINKS_DENIED_TTL_MS = 10 * 60_000;

/**
 * Per-warehouse {@link ArrowCapability}, so a query skips delivery modes the
 * warehouse is known not to serve. `"links-denied"` lapses after ten minutes and
 * then reads as `"external"`, so Cloud Fetch is tried again.
 */
export class ArrowCapabilityMemo {
  private readonly entries = new Map<
    string,
    { capability: ArrowCapability; until?: number }
  >();

  get(warehouseId: string): ArrowCapability | undefined {
    const entry = this.entries.get(warehouseId);
    if (entry?.until !== undefined && Date.now() >= entry.until) {
      return "external";
    }
    return entry?.capability;
  }

  set(warehouseId: string, capability: ArrowCapability): void {
    this.entries.set(warehouseId, {
      capability,
      until:
        capability === "links-denied"
          ? Date.now() + LINKS_DENIED_TTL_MS
          : undefined,
    });
  }
}

/** A capability hint and a report callback, so the caller can memoize the mode per warehouse. */
interface ArrowDeliveryOptions {
  /**
   * `"inline"` or undefined attempts `INLINE+ARROW_STREAM` first (the Reyden
   * path). Any other hint skips it — a standard warehouse rejects INLINE arrow
   * on every query, so once we've learned that, the probe is pure waste.
   */
  capabilityHint?: ArrowCapability;
  /**
   * Called when a delivery mode delivers its first byte, or when storage is
   * shown to deny Cloud Fetch (`"links-denied"`).
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

/** A view over a base64 attachment's bytes, decoded once. */
function attachmentBytes(attachment: string): Uint8Array {
  const decoded = Buffer.from(attachment, "base64");
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

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
async function* deliverArrowBytes(
  executor: QueryExecutor,
  streamer: ArrowChunkStreamer,
  query: string,
  processedParams: Record<string, SQLTypeMarker | null | undefined> | undefined,
  out: DeliveryState,
  signal?: AbortSignal,
  opts?: ArrowDeliveryOptions,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (opts?.capabilityHint === undefined || opts.capabilityHint === "inline") {
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
        yield attachmentBytes(result.attachment);
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
  out.columnNames = ext.columnNames;
  out.statementId = ext.statement_id;
  // Stream the pre-signed links resolved in THIS request's execution context
  // (user creds for `.obo.sql`, service principal otherwise). Pre-signed URLs
  // need no auth to download, so there is no second `getStatement` under a
  // mismatched identity. `refreshChunkLink` (also bound to this context) lets
  // the streamer re-mint a link that expires mid-download.
  const links = ext.external_links;
  const refresh = ext.refreshChunkLink;
  async function* stream(fullHeaderWait: boolean) {
    const bytes = streamer.streamExternalLinks(
      links,
      signal,
      refresh,
      fullHeaderWait,
    );
    const first = await bytes.next();
    opts?.onCapabilityResolved?.("external");
    if (!first.done) yield first.value;
    yield* bytes;
  }
  out.cloudFetch = { totalByteCount: ext.totalByteCount, stream };
  yield* stream(false);
}

/** The warehouse aborts an INLINE statement whose result is over 25 MiB. */
function isInlineLimitExceeded(err: unknown): boolean {
  return (
    err instanceof ExecutionError &&
    err.errorCode === "BAD_REQUEST" &&
    err.message.toLowerCase().includes("inline byte limit exceeded")
  );
}

/** `undefined` when the result is too large to send inline. */
async function inlineJsonAsArrow(
  executor: QueryExecutor,
  query: string,
  processedParams: Record<string, SQLTypeMarker | null | undefined> | undefined,
  out: ArrowDeliveryOut,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  let result: Awaited<ReturnType<QueryExecutor["query"]>>;
  try {
    result = await executor.query(
      query,
      processedParams,
      { disposition: "INLINE", format: "JSON_ARRAY", asArrow: true },
      signal,
    );
  } catch (err: unknown) {
    if (isInlineLimitExceeded(err)) return undefined;
    throw err;
  }
  if (!result?.attachment) throw ExecutionError.missingData("attachment");
  out.columnNames = result.columnNames;
  out.statementId = result.statement_id;
  return attachmentBytes(result.attachment);
}

function linksDenied(cause: ExecutionError): ExecutionError {
  return new ExecutionError(
    `Cloud Fetch download failed and the result is too large to send inline: ${cause.message}`,
    {
      errorCode: "EXTERNAL_LINKS_DENIED",
      cause,
      clientMessage:
        "The query result could not be downloaded from workspace storage and is too large to send inline. Check the workspace storage firewall and the app's network policy.",
    },
  );
}

type Download =
  | { stream: AsyncGenerator<Uint8Array, void, unknown> }
  | NonNullable<ReturnType<typeof asDownloadFailure>>;

/** Pull the first chunk, so a failed download surfaces before the route sends headers. */
async function startDownload(
  bytes: AsyncGenerator<Uint8Array, void, unknown>,
): Promise<Download> {
  let first: IteratorResult<Uint8Array, void>;
  try {
    first = await bytes.next();
  } catch (error: unknown) {
    const failure = asDownloadFailure(error);
    if (!failure) throw error;
    return failure;
  }
  return {
    stream: (async function* () {
      if (!first.done) yield first.value;
      yield* bytes;
    })(),
  };
}

/**
 * {@link deliverArrowBytes}, falling back to an inline `JSON_ARRAY` run when the
 * Cloud Fetch download fails before its first byte.
 *
 * A refusal (400/403 after the re-mint) reports `"links-denied"` at once; a
 * download that never answers reports it after the fallback, since blocked
 * hosts hang instead of refusing. Other download errors fall back without being
 * remembered. A result too large for inline fails with `EXTERNAL_LINKS_DENIED`
 * after a refusal; otherwise it gets one Cloud Fetch retry with the full header
 * wait, and `EXTERNAL_LINKS_DENIED` only if storage again refuses or never answers. With the `"links-denied"` hint, inline runs first and only a
 * result too large for it goes back to Cloud Fetch.
 */
export async function* deliverArrowBytesWithFallback(
  executor: QueryExecutor,
  streamer: ArrowChunkStreamer,
  query: string,
  processedParams: Record<string, SQLTypeMarker | null | undefined> | undefined,
  out: ArrowDeliveryOut,
  signal?: AbortSignal,
  opts?: ArrowDeliveryOptions,
): AsyncGenerator<Uint8Array, void, unknown> {
  const state: DeliveryState = out;
  const inline = () =>
    inlineJsonAsArrow(executor, query, processedParams, out, signal);
  const remember = (capability: ArrowCapability) =>
    opts?.onCapabilityResolved?.(capability);
  let tooLarge = false;
  if (opts?.capabilityHint === "links-denied") {
    const bytes = await inline();
    if (bytes) {
      yield bytes;
      return;
    }
    tooLarge = true;
  }

  const download = await startDownload(
    deliverArrowBytes(
      executor,
      streamer,
      query,
      processedParams,
      state,
      signal,
      opts,
    ),
  );
  if ("stream" in download) {
    yield* download.stream;
    return;
  }

  const { kind, error } = download;
  if (kind === "refused") remember("links-denied");
  const size = state.cloudFetch?.totalByteCount;
  tooLarge ||= size !== undefined && size > MAX_INLINE_ATTACHMENT_BYTES;
  if (!tooLarge) {
    logger.warn(
      "Cloud Fetch download failed (%s), serving the result inline: %s",
      kind,
      error.message,
    );
    const bytes = await inline();
    if (bytes) {
      if (kind === "unanswered") remember("links-denied");
      yield bytes;
      return;
    }
  }
  if (kind === "refused") throw linksDenied(error);
  if (!state.cloudFetch) throw error;

  logger.warn(
    "Cloud Fetch download failed (%s) on a result too large for inline, retrying with the full header wait",
    kind,
  );
  const retry = await startDownload(state.cloudFetch.stream(true));
  if ("stream" in retry) {
    yield* retry.stream;
    return;
  }
  const denied = retry.kind !== "other";
  if (denied || kind === "unanswered") remember("links-denied");
  throw denied ? linksDenied(retry.error) : retry.error;
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

/**
 * Recursively render a nested Arrow value (List / Struct / Map, or a scalar
 * leaf) to the plain JS shape the warehouse nests inside a JSON_ARRAY cell:
 * structs and maps become objects, lists become arrays, and every scalar leaf
 * is stringified per {@link formatJsonArrayCell}. The caller `JSON.stringify`s the
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
      return formatJsonArrayCell(value, type);
  }
}

const NESTED_TYPES = new Set<Type>([
  Type.List,
  Type.FixedSizeList,
  Type.Struct,
  Type.Map,
]);

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
      } else if (NESTED_TYPES.has(type.typeId)) {
        // The native JSON_ARRAY wire sends nested columns as JSON text with
        // every scalar leaf stringified by type.
        row[name] = JSON.stringify(renderNestedValue(v, type));
      } else if (typeof v === "string") {
        row[name] = maybeParseJsonString(v);
      } else {
        row[name] = formatJsonArrayCell(v, type);
      }
    }
    rows.push(row);
  }
  return rows;
}
