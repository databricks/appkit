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
 * Subscribe to an analytics query over SSE and returns its latest result
 * Integration hook between client and analytics plugin
 * @param queryKey - Analytics query identifier
 * @param parameters - Query parameters (type-safe based on QueryRegistry)
 * @param options - Analytics query settings
 * @returns - Query result state
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
