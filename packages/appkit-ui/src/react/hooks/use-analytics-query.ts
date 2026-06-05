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

function getArrowStreamUrl(id: string): string {
  return `/api/analytics/arrow-result/${id}`;
}

const GENERIC_LOAD_ERROR = "Unable to load data, please try again";

interface AnalyticsQuerySseContext<ResultType> {
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
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

  if (parsed.type === "result") {
    ctx.setLoading(false);
    ctx.setData(parsed.data as ResultType);
    ctx.unpublishWarehouseStatus();
    return;
  }

  if (parsed.type === "arrow") {
    try {
      const arrowData = await ArrowClient.fetchArrow(
        getArrowStreamUrl(parsed.statement_id as string),
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
    if (parsed.code) {
      console.error(
        `[useAnalyticsQuery] Code: ${parsed.code}, Message: ${errorMsg}`,
      );
    }
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
 * @example JSON format (default)
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params);
 * // data: Array<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 *
 * @example Arrow format
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
    setData(null);
    setWarehouseStatus(null);
    publishWarehouseStatus(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const sseContext: AnalyticsQuerySseContext<ResultType> = {
      setLoading,
      setError,
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
        try {
          const parsed = JSON.parse(message.data) as Record<string, unknown>;
          await handleAnalyticsSseMessage(parsed, sseContext);
        } catch (error) {
          console.warn("[useAnalyticsQuery] Malformed message received", error);
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

  return { data, loading, error, warehouseStatus };
}
