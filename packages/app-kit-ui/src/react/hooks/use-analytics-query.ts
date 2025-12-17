import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectSSE } from "@/js";
import type {
  InferParams,
  InferResult,
  QueryKey,
  UseAnalyticsQueryOptions,
  UseAnalyticsQueryResult,
} from "./types";
import { useQueryHMR } from "./use-query-hmr";

function getDevMode() {
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;
  const dev = searchParams.get("dev");

  return dev ? `?dev=${dev}` : "";
}

/**
 * React hook for executing analytics queries with real-time updates via Server-Sent Events.
 *
 * Provides automatic query execution, loading states, error handling, and HMR support
 * in development. The hook manages the SSE connection lifecycle and cleans up on unmount.
 *
 * @param queryKey - Query identifier matching a .sql file in your queries directory
 * @param parameters - Type-safe query parameters (inferred from QueryRegistry if available)
 * @param options - Query execution options
 * @param options.autoStart - Whether to start query execution automatically (default: true)
 * @param options.format - Optional result format transformation
 * @param options.maxParametersSize - Maximum payload size in bytes (default: 100KB)
 * @returns Query state object with data, loading, and error properties
 *
 * @example
 * Basic query execution
 * ```typescript
 * import { useAnalyticsQuery } from '@databricks/app-kit-ui';
 *
 * function UserStats() {
 *   const { data, loading, error } = useAnalyticsQuery('user_stats', {
 *     userId: 123
 *   });
 *
 *   if (loading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error}</div>;
 *   return <div>User: {data?.name}</div>;
 * }
 * ```
 *
 * @example
 * Manual query execution
 * ```typescript
 * import { useAnalyticsQuery } from '@databricks/app-kit-ui';
 *
 * function DataExplorer() {
 *   const { data, loading, error, start } = useAnalyticsQuery(
 *     'complex_query',
 *     { filters: {...} },
 *     { autoStart: false }
 *   );
 *
 *   return (
 *     <button onClick={start} disabled={loading}>
 *       Run Query
 *     </button>
 *   );
 * }
 * ```
 */
export function useAnalyticsQuery<T = unknown, K extends QueryKey = QueryKey>(
  queryKey: K,
  parameters?: InferParams<K> | null,
  options: UseAnalyticsQueryOptions = { autoStart: true },
): UseAnalyticsQueryResult<InferResult<T, K>> {
  const format = options?.format;
  const maxParametersSize = options?.maxParametersSize ?? 100 * 1024;

  const [data, setData] = useState<InferResult<T, K> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  if (!queryKey || queryKey.trim().length === 0) {
    throw new Error(
      "useAnalyticsQuery: 'queryKey' must be a non-empty string.",
    );
  }

  const payload = useMemo(() => {
    try {
      const serialized = JSON.stringify({ parameters, format });
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
  }, [parameters, format, maxParametersSize]);

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

    const devMode = getDevMode();

    connectSSE({
      url: `/api/analytics/query/${encodeURIComponent(queryKey)}${devMode}`,
      payload: payload,
      signal: abortController.signal,
      onMessage: (message) => {
        try {
          const parsed = JSON.parse(message.data);

          // success
          if (parsed.type === "result") {
            setLoading(false);
            setData(parsed.data);
            return;
          }

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
  }, [queryKey, payload]);

  useEffect(() => {
    if (options?.autoStart) {
      start();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [start, options?.autoStart]);

  // Enable HMR for query updates in dev mode
  useQueryHMR(queryKey, start);

  return { data, loading, error };
}
