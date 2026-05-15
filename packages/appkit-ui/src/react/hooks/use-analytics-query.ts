import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalyticsSseMessage } from "shared";
import { ArrowClient, connectSSE } from "@/js";
import type {
  AnalyticsFormat,
  InferParams,
  InferResultByFormat,
  QueryKey,
  UseAnalyticsQueryOptions,
  UseAnalyticsQueryResult,
} from "./types";
import { useQueryHMR } from "./use-query-hmr";

/**
 * Shallow structural equality for analytics query parameter objects.
 *
 * Analytics query parameters are produced by the `sql.*` builders and are
 * always plain objects keyed to primitive values (string | number | boolean
 * | null | undefined), so shallow equality is sufficient and substantially
 * cheaper than a full deep-equal.
 */
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

/**
 * Stabilize a value's identity across renders when it is structurally equal
 * to the previous value. Used to make object-literal parameters safe to pass
 * directly to `useAnalyticsQuery` without forcing every consumer to wrap
 * params in `useMemo`.
 */
function useStableParams<T>(value: T): T {
  const ref = useRef<T>(value);
  if (!shallowEqualParams(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}

function getDevMode() {
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;
  const dev = searchParams.get("dev");

  return dev ? `?dev=${dev}` : "";
}

function getArrowStreamUrl(id: string) {
  return `/api/analytics/arrow-result/${id}`;
}

/**
 * Subscribe to an analytics query over SSE and returns its latest result.
 * Integration hook between client and analytics plugin.
 *
 * The return type is automatically inferred based on the format:
 * - `format: "ARROW_STREAM"` (default): Returns TypedArrowTable with row type preserved — works across all warehouse variants and avoids JSON serialization cost
 * - `format: "JSON_ARRAY"`: Returns typed array from QueryRegistry
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
 * @example ARROW_STREAM format (default)
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params);
 * // data: TypedArrowTable<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 *
 * @example JSON_ARRAY format
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params, { format: "JSON_ARRAY" });
 * // data: Array<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 */
export function useAnalyticsQuery<
  T = unknown,
  K extends QueryKey = QueryKey,
  F extends AnalyticsFormat = "ARROW_STREAM",
>(
  queryKey: K,
  parameters?: InferParams<K> | null,
  options: UseAnalyticsQueryOptions<F> = {} as UseAnalyticsQueryOptions<F>,
): UseAnalyticsQueryResult<InferResultByFormat<T, K, F>> {
  const format = options?.format ?? "ARROW_STREAM";
  const maxParametersSize = options?.maxParametersSize ?? 100 * 1024;
  const autoStart = options?.autoStart ?? true;

  const devMode = getDevMode();
  const urlSuffix = `/api/analytics/query/${encodeURIComponent(queryKey)}${devMode}`;

  type ResultType = InferResultByFormat<T, K, F>;
  const [data, setData] = useState<ResultType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  if (!queryKey || queryKey.trim().length === 0) {
    throw new Error(
      "useAnalyticsQuery: 'queryKey' must be a non-empty string.",
    );
  }

  // Stabilize the parameters reference across renders. Without this, a fresh
  // object literal at the call site (e.g. `useAnalyticsQuery("k", { limit: 10 })`)
  // would change identity every render, invalidating the `payload` memo and
  // re-running `start` -> infinite refetch loop.
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

    // Abort previous request if exists
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setLoading(true);
    setError(null);
    setData(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    connectSSE({
      url: urlSuffix,
      payload: payload,
      signal: abortController.signal,
      onMessage: async (message) => {
        try {
          const rawParsed = JSON.parse(message.data);

          // The error/code branch below predates the SSE wire schema and
          // can fire for messages that don't match any AnalyticsSseMessage
          // variant (e.g. server-side error events from executeStream).
          // Try schema validation first; if it fails, fall through to the
          // generic error/code handling below.
          const validated = AnalyticsSseMessage.safeParse(rawParsed);
          const msg = validated.success ? validated.data : null;

          // success - JSON format. The wire schema makes `data` optional
          // (e.g. an empty result set may omit it), so normalize the
          // missing case to an explicit empty array rather than letting
          // `undefined` bleed into the hook's `T | null` state.
          if (msg?.type === "result") {
            setLoading(false);
            setData((msg.data ?? []) as ResultType);
            return;
          }

          // success - Arrow format. Both INLINE (server-stashed,
          // statement_id prefixed with "inline-") and EXTERNAL_LINKS
          // (warehouse statement_id) flow through this single branch — the
          // /arrow-result route dispatches based on the id prefix so the
          // client doesn't need to know which path the bytes came from.
          if (msg?.type === "arrow") {
            try {
              const arrowData = await ArrowClient.fetchArrow(
                getArrowStreamUrl(msg.statement_id),
              );
              const table = await ArrowClient.processArrowBuffer(arrowData);
              setLoading(false);
              // Table is cast to TypedArrowTable with row type from QueryRegistry
              setData(table as ResultType);
              return;
            } catch (error) {
              console.error(
                "[useAnalyticsQuery] Failed to fetch Arrow data",
                error,
              );
              setLoading(false);
              setError("Unable to load data, please try again");
              return;
            }
          }

          // The schema didn't match — fall through to error/code handling
          // below for legacy error events or surface a malformed-payload
          // error if no error fields are present.
          const parsed = rawParsed;

          // error
          if (parsed.type === "error" || parsed.error || parsed.code) {
            const errorMsg =
              parsed.error || parsed.message || "Unable to execute query";

            setLoading(false);
            setError(errorMsg);

            if (parsed.code) {
              console.error(
                `[useAnalyticsQuery] Code: ${parsed.code}, Message: ${errorMsg}`,
              );
            }
            return;
          }

          // The payload matched neither AnalyticsSseMessage nor an error
          // event — surface a generic error rather than silently dropping it.
          if (!validated.success) {
            console.error(
              "[useAnalyticsQuery] Malformed SSE payload",
              validated.error.flatten(),
            );
            setLoading(false);
            setError("Unable to load data, please try again");
            return;
          }
        } catch (error) {
          console.warn("[useAnalyticsQuery] Malformed message received", error);
        }
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        setLoading(false);

        let userMessage = "Unable to load data, please try again";

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
  }, [queryKey, payload, urlSuffix]);

  useEffect(() => {
    if (autoStart) {
      start();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [start, autoStart]);

  // Enable HMR for query updates in dev mode
  useQueryHMR(queryKey, start);

  return { data, loading, error };
}
