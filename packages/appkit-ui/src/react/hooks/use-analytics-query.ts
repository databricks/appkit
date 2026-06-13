import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnalyticsSseMessage } from "shared";
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

function getArrowStreamUrl(id: string): string {
  return `/api/analytics/arrow-result/${id}`;
}

const GENERIC_LOAD_ERROR = "Unable to load data, please try again";

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

  // The error/code branch below predates the SSE wire schema and can fire
  // for messages that don't match any AnalyticsSseMessage variant (e.g.
  // server-side error events from executeStream). Validate the known
  // result/arrow variants first; fall through to error handling otherwise.
  const validated = AnalyticsSseMessage.safeParse(parsed);
  const msg = validated.success ? validated.data : null;

  // success - JSON format. The wire schema makes `data` optional (e.g. an
  // empty result set may omit it), so normalize the missing case to an
  // explicit empty array rather than letting `undefined` bleed into the
  // hook's `T | null` state.
  if (msg?.type === "result") {
    ctx.setLoading(false);
    ctx.setData((msg.data ?? []) as ResultType);
    ctx.unpublishWarehouseStatus();
    return;
  }

  // success - Arrow format. Both INLINE (server-stashed, statement_id
  // prefixed with "inline-") and EXTERNAL_LINKS (warehouse statement_id)
  // flow through this single branch — the /arrow-result route dispatches
  // based on the id prefix so the client doesn't need to know which path
  // the bytes came from.
  if (msg?.type === "arrow") {
    try {
      const arrowData = await ArrowClient.fetchArrow(
        getArrowStreamUrl(msg.statement_id),
      );
      const table = await ArrowClient.processArrowBuffer(arrowData);
      ctx.setLoading(false);
      ctx.setData(table as ResultType);
      ctx.unpublishWarehouseStatus();
    } catch (error) {
      console.error("[useAnalyticsQuery] Failed to fetch Arrow data", error);
      ctx.setLoading(false);
      ctx.setError(GENERIC_LOAD_ERROR);
      ctx.unpublishWarehouseStatus();
    }
    return;
  }

  if (parsed.type === "error" || parsed.error || parsed.code) {
    const errorMsg =
      (parsed.error as string | undefined) ||
      (parsed.message as string | undefined) ||
      "Unable to execute query";
    ctx.setLoading(false);
    ctx.setError(errorMsg);
    ctx.unpublishWarehouseStatus();
    // Propagate the upstream structured code so UI consumers can branch on
    // a stable identifier (e.g. retry on INLINE_ARROW_STASH_EXHAUSTED,
    // format-switch on RESULT_TOO_LARGE_FOR_JSON_FALLBACK) instead of
    // parsing the human-readable message.
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

  // The payload matched neither AnalyticsSseMessage nor an error event —
  // surface a generic error rather than silently dropping it.
  if (!validated.success) {
    console.error(
      "[useAnalyticsQuery] Malformed SSE payload",
      validated.error.flatten(),
    );
    ctx.setLoading(false);
    ctx.setError(GENERIC_LOAD_ERROR);
    ctx.unpublishWarehouseStatus();
  }
}

/**
 * Subscribe to an analytics query over SSE and returns its latest result.
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
          setError("Unable to load data, please try again");
          abortController.abort();
        }
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        setLoading(false);
        unpublishWarehouseStatus();

        let userMessage = GENERIC_LOAD_ERROR;
        if (error instanceof Error) {
          if (error.name === "AbortError") {
            userMessage = "Request timed out, please try again";
          } else if (error.message.includes("Failed to fetch")) {
            userMessage = "Network error. Please check your connection.";
          }
          console.error("[useAnalyticsQuery] Error", {
            queryKey,
            error: error.message,
            stack: error.stack,
          });
        }
        setError(userMessage);
      },
    });
  }, [
    queryKey,
    payload,
    urlSuffix,
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
