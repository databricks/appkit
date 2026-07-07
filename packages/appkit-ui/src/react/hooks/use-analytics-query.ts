import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowClient, connectSSE } from "@/js";
import type {
  AnalyticsFormat,
  InferParams,
  InferResultByFormat,
  QueryKey,
  UseAnalyticsQueryOptions,
  UseAnalyticsQueryResult,
  WarehouseStatus,
} from "./types";
import { useAnalyticsWarehousePublisher } from "./use-analytics-warehouse-status";
import { useQueryHMR } from "./use-query-hmr";

/** Shallow equality for plain-object query parameters (primitive values only). */
function shallowEqualParams(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Keep structurally-equal params referentially stable across renders. */
function useStableParams<T>(value: T): T {
  const ref = useRef<T>(value);
  if (!shallowEqualParams(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}

function getDevMode(): string {
  const dev = new URL(window.location.href).searchParams.get("dev");
  return dev ? `?dev=${dev}` : "";
}

const GENERIC_LOAD_ERROR = "Unable to load data, please try again";

/** Map a fetch/SSE transport error to a user-facing message. */
function userFacingFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Request timed out, please try again";
    }
    if (error.message.includes("Failed to fetch")) {
      return "Network error. Please check your connection.";
    }
  }
  return GENERIC_LOAD_ERROR;
}

interface AnalyticsQuerySseContext<ResultType> {
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setErrorCode: (code: string | null) => void;
  setData: (data: ResultType | null) => void;
  setWarehouseStatus: (status: WarehouseStatus | null) => void;
  publishWarehouseStatus: (status: WarehouseStatus | null) => void;
  unpublishWarehouseStatus: () => void;
}

function isWarehouseStatusPayload(value: unknown): value is WarehouseStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WarehouseStatus).state === "string"
  );
}

async function handleAnalyticsSseMessage<ResultType>(
  parsed: Record<string, unknown>,
  ctx: AnalyticsQuerySseContext<ResultType>,
): Promise<void> {
  if (parsed.type === "warehouse_status") {
    if (!isWarehouseStatusPayload(parsed.status)) {
      ctx.setLoading(false);
      ctx.setError(GENERIC_LOAD_ERROR);
      ctx.unpublishWarehouseStatus();
      console.error(
        "[useAnalyticsQuery] Malformed warehouse_status event",
        parsed,
      );
      return;
    }
    ctx.setWarehouseStatus(parsed.status);
    ctx.publishWarehouseStatus(parsed.status);
    return;
  }

  // JSON result. The SSE wire schema is intentionally loose (`data` is an
  // optional array of unknown values), so a structural check is enough here —
  // no need to ship a schema validator (zod, ~60 KB gz) to the browser just
  // to read our own same-origin server's messages. Missing or non-array
  // `data` normalizes to [] so `undefined` never bleeds into the hook's
  // `T | null` state.
  if (parsed.type === "result") {
    ctx.setLoading(false);
    ctx.setData((Array.isArray(parsed.data) ? parsed.data : []) as ResultType);
    ctx.unpublishWarehouseStatus();
    return;
  }

  // NOTE: ARROW_STREAM no longer flows over SSE — the server streams the
  // raw Arrow IPC bytes back as the query response body, handled by
  // `fetchArrowDirect` instead of this SSE handler.

  if (parsed.type === "error" || parsed.error || parsed.code) {
    const errorMsg =
      (parsed.error as string | undefined) ||
      (parsed.message as string | undefined) ||
      "Unable to execute query";
    ctx.setLoading(false);
    ctx.setError(errorMsg);
    ctx.unpublishWarehouseStatus();
    // Propagate the upstream structured code so UI consumers can branch on
    // a stable identifier (e.g. format-switch on
    // RESULT_TOO_LARGE_FOR_JSON_FALLBACK or ARROW_DELIVERY_UNSUPPORTED)
    // instead of parsing the human-readable message.
    if (typeof parsed.errorCode === "string") {
      ctx.setErrorCode(parsed.errorCode);
    }
    if (parsed.code) {
      console.error(
        `[useAnalyticsQuery] Code: ${parsed.code}, Message: ${errorMsg}`,
      );
    }
    return;
  }

  // Not a warehouse-status, result, or error event — surface a generic error
  // rather than silently dropping an unrecognized payload.
  console.error("[useAnalyticsQuery] Unrecognized SSE payload", parsed);
  ctx.setLoading(false);
  ctx.setError(GENERIC_LOAD_ERROR);
  ctx.unpublishWarehouseStatus();
}

interface ArrowDirectContext {
  url: string;
  payload: string;
  signal: AbortSignal;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setErrorCode: (code: string | null) => void;
  setData: (data: unknown) => void;
  unpublishWarehouseStatus: () => void;
}

/**
 * Fetch the real column names for a statement from the fallback endpoint,
 * used when a very wide schema's names didn't fit in the response header.
 * Returns undefined on any failure so decoding falls back to the raw Arrow
 * schema names.
 */
async function fetchArrowColumns(
  statementId: string,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  try {
    const res = await fetch(
      `/api/analytics/columns/${encodeURIComponent(statementId)}`,
      { signal },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { columns?: unknown };
    return Array.isArray(body.columns) ? (body.columns as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch an ARROW_STREAM query result as raw Arrow IPC bytes directly from
 * the query endpoint (no SSE, no second /arrow-result request) and decode
 * it into a Table. The server streams the bytes back as the POST response
 * body; errors before the first byte arrive as a JSON `{ error, errorCode }`.
 */
async function fetchArrowDirect(ctx: ArrowDirectContext): Promise<void> {
  try {
    const response = await fetch(ctx.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ctx.payload,
      signal: ctx.signal,
    });
    if (ctx.signal.aborted) return;

    if (!response.ok) {
      let message = GENERIC_LOAD_ERROR;
      let code: string | null = null;
      try {
        const body = (await response.json()) as {
          error?: string;
          errorCode?: string;
        };
        if (body.error) message = body.error;
        if (typeof body.errorCode === "string") code = body.errorCode;
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      ctx.setLoading(false);
      ctx.setError(message);
      if (code) ctx.setErrorCode(code);
      ctx.unpublishWarehouseStatus();
      return;
    }

    const buffer = await response.arrayBuffer();
    if (ctx.signal.aborted) return;
    // Databricks encodes ARROW_STREAM columns positionally (col_0, …); the
    // server sends the real manifest names so we can relabel the decoded
    // Table (charts look columns up by name). Normally inline in the
    // `X-Appkit-Arrow-Columns` header; for very wide schemas the header
    // carries only a statement-id reference and we fetch the names.
    let columnNames: string[] | undefined;
    const header = response.headers.get("X-Appkit-Arrow-Columns");
    if (header) {
      try {
        columnNames = JSON.parse(decodeURIComponent(header));
      } catch {
        // Malformed header — fall back to the raw Arrow schema names.
      }
    } else {
      const ref = response.headers.get("X-Appkit-Arrow-Columns-Ref");
      if (ref) {
        columnNames = await fetchArrowColumns(ref, ctx.signal);
      }
    }
    const table = await ArrowClient.processArrowBuffer(
      new Uint8Array(buffer),
      columnNames,
    );
    ctx.setData(table);
    ctx.setLoading(false);
    ctx.unpublishWarehouseStatus();
  } catch (error) {
    if (ctx.signal.aborted) return;
    ctx.setLoading(false);
    ctx.unpublishWarehouseStatus();
    ctx.setError(userFacingFetchError(error));
  }
}

/**
 * Subscribe to an analytics query and return its latest result. JSON_ARRAY
 * results stream over SSE (with warehouse-readiness progress); ARROW_STREAM
 * results are fetched as raw Arrow bytes directly from the query endpoint.
 * Integration hook between client and analytics plugin.
 *
 * The return type is automatically inferred based on the format:
 * - `format: "JSON_ARRAY"` (default): Returns typed array from QueryRegistry
 * - `format: "ARROW_STREAM"`: Returns TypedArrowTable with row type preserved
 *
 * Note: User context execution is determined by query file naming:
 * - `queryKey.obo.sql`: Executes as user (OBO = on-behalf-of / user delegation)
 * - `queryKey.sql`: Executes as service principal
 *
 * @param queryKey - Analytics query identifier
 * @param parameters - Query parameters (type-safe based on QueryRegistry)
 * @param options - Analytics query settings including format
 * @returns Query result state with format-appropriate data type
 *
 * @example JSON_ARRAY format (default)
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params);
 * // data: Array<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 *
 * @example ARROW_STREAM format
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params, { format: "ARROW_STREAM" });
 * // data: TypedArrowTable<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 */
export function useAnalyticsQuery<
  T = unknown,
  K extends QueryKey = QueryKey,
  F extends AnalyticsFormat = "JSON_ARRAY",
>(
  queryKey: K,
  parameters?: InferParams<K> | null,
  options: UseAnalyticsQueryOptions<F> = {} as UseAnalyticsQueryOptions<F>,
): UseAnalyticsQueryResult<InferResultByFormat<T, K, F>> {
  const format = options?.format ?? "JSON_ARRAY";
  const maxParametersSize = options?.maxParametersSize ?? 100 * 1024;
  const autoStart = options?.autoStart ?? true;

  const devMode = getDevMode();
  const urlSuffix = `/api/analytics/query/${encodeURIComponent(queryKey)}${devMode}`;

  type ResultType = InferResultByFormat<T, K, F>;
  const [data, setData] = useState<ResultType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [warehouseStatus, setWarehouseStatus] =
    useState<WarehouseStatus | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const publisherId = useId();
  const {
    publish: publishWarehouseStatus,
    unpublish: unpublishWarehouseStatus,
  } = useAnalyticsWarehousePublisher(publisherId, queryKey);

  if (!queryKey || queryKey.trim().length === 0) {
    throw new Error(
      "useAnalyticsQuery: 'queryKey' must be a non-empty string.",
    );
  }

  const stableParameters = useStableParams(parameters);

  const payload = useMemo(() => {
    try {
      const serialized = JSON.stringify({
        parameters: stableParameters,
        format,
      });
      const sizeInBytes = new Blob([serialized]).size;
      if (sizeInBytes > maxParametersSize) {
        throw new Error(
          "useAnalyticsQuery: Parameters size exceeds the maximum allowed size",
        );
      }

      return serialized;
    } catch (error) {
      console.error("useAnalyticsQuery: Failed to serialize parameters", error);
      return null;
    }
  }, [stableParameters, format, maxParametersSize]);

  const start = useCallback(() => {
    if (payload === null) {
      setError("Failed to serialize query parameters");
      return;
    }

    abortControllerRef.current?.abort();

    setLoading(true);
    setError(null);
    setErrorCode(null);
    setData(null);
    setWarehouseStatus(null);
    publishWarehouseStatus(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // ARROW_STREAM: the server streams raw Arrow IPC bytes back on the query
    // response body (no SSE). Fetch and decode directly.
    if (format === "ARROW_STREAM") {
      void fetchArrowDirect({
        url: urlSuffix,
        payload,
        signal: abortController.signal,
        setLoading,
        setError,
        setErrorCode,
        setData: (table) => setData(table as ResultType),
        unpublishWarehouseStatus,
      });
      return;
    }

    const sseContext: AnalyticsQuerySseContext<ResultType> = {
      setLoading,
      setError,
      setErrorCode,
      setData,
      setWarehouseStatus,
      publishWarehouseStatus,
      unpublishWarehouseStatus,
    };

    connectSSE({
      url: urlSuffix,
      payload,
      signal: abortController.signal,
      onMessage: async (message) => {
        // Drop late envelopes from a stream whose controller was already
        // aborted (React StrictMode unmount→remount). Mirrors onError below.
        if (abortController.signal.aborted) return;
        try {
          const parsed = JSON.parse(message.data) as Record<string, unknown>;
          await handleAnalyticsSseMessage(parsed, sseContext);
        } catch (error) {
          // A `JSON.parse` failure (or any other thrown error inside the
          // SSE message handler) used to leave the hook permanently in
          // `loading=true` with no error surfaced — the UI would just
          // spin forever. Clear loading and report a user-facing error
          // so the consumer can render a retry affordance.
          //
          // We also abort the SSE connection: if the upstream is
          // emitting un-parseable frames, leaving the stream open just
          // re-fires the same failure on the next message. Closing
          // forces the consumer into a clean retry path.
          console.warn("[useAnalyticsQuery] Malformed message received", error);
          setLoading(false);
          setError(GENERIC_LOAD_ERROR);
          abortController.abort();
        }
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        setLoading(false);
        unpublishWarehouseStatus();

        if (error instanceof Error) {
          console.error("[useAnalyticsQuery] Error", {
            queryKey,
            error: error.message,
            stack: error.stack,
          });
        }
        setError(userFacingFetchError(error));
      },
    });
  }, [
    queryKey,
    payload,
    urlSuffix,
    format,
    publishWarehouseStatus,
    unpublishWarehouseStatus,
  ]);

  useEffect(() => {
    if (autoStart) {
      start();
    }

    return () => {
      abortControllerRef.current?.abort();
      unpublishWarehouseStatus();
    };
  }, [start, autoStart, unpublishWarehouseStatus]);

  useQueryHMR(queryKey, start);

  return { data, loading, error, errorCode, warehouseStatus };
}
