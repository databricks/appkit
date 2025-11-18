import { connectSSE } from "@databricks-apps/js";
import { useEffect, useMemo, useState } from "react";
import type {
  UseAnalyticsQueryOptions,
  UseAnalyticsQueryResult,
} from "./types";

/**
 * Subscribe to an analytics query over SSE and returns its latest result
 * Integration hook between client and analytics plugin
 * @param queryKey - Analytics query identifier
 * @param parameters - Optional query parameters
 * @param options - Analytics query settings
 * @returns - Query result state
 */
export function useAnalyticsQuery<
  T,
  P extends Record<string, unknown> = Record<string, unknown>,
>(
  queryKey: string,
  parameters?: P | null,
  options?: UseAnalyticsQueryOptions,
): UseAnalyticsQueryResult<T> {
  const format = options?.format;
  const maxParametersSize = options?.maxParametersSize ?? 100 * 1024;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (payload === null) {
      setError("Failed to serialize query parameters");
      return;
    }

    setLoading(true);
    setError(null);
    setData(null);

    const abortController = new AbortController();

    connectSSE({
      url: `/api/analytics/query/${encodeURIComponent(queryKey)}`,
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

    return () => {
      abortController.abort();
    };
  }, [queryKey, payload]);

  return { data, loading, error };
}
