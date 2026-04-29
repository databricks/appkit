import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectSSE } from "@/js";
import type {
  AnalyticsFormat,
  MetricKey,
  MetricRow,
  UseMetricViewArgs,
  UseMetricViewOptions,
  UseMetricViewResult,
} from "./types";

/**
 * Subscribe to a metric-view query over SSE.
 *
 * Phase 1 surface — accepts `{ measures }` only. Phase 2/3 widen to
 * `dimensions`, `filter`, `timeGrain`. The hook signature mirrors
 * `useAnalyticsQuery`'s shape so that adopters muscle-memorize the call
 * pattern across the two hooks.
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useMetricView("revenue", {
 *   measures: ["arr"],
 * });
 * ```
 */
export function useMetricView<
  K extends MetricKey = MetricKey,
  F extends AnalyticsFormat = "JSON",
>(
  metricKey: K,
  args: UseMetricViewArgs<K>,
  options: UseMetricViewOptions<F> = {} as UseMetricViewOptions<F>,
): UseMetricViewResult<MetricRow<K>> {
  if (!metricKey || metricKey.trim().length === 0) {
    throw new Error("useMetricView: 'metricKey' must be a non-empty string.");
  }

  const format = options.format ?? "JSON";
  const autoStart = options.autoStart ?? true;
  const maxParametersSize = options.maxParametersSize ?? 100 * 1024;

  const url = `/api/analytics/metric/${encodeURIComponent(metricKey)}`;

  type ResultType = MetricRow<K>;
  const [data, setData] = useState<ResultType[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const payload = useMemo(() => {
    try {
      const body = {
        measures: [...args.measures],
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        format,
      };
      const serialized = JSON.stringify(body);
      const sizeInBytes = new Blob([serialized]).size;
      if (sizeInBytes > maxParametersSize) {
        throw new Error(
          "useMetricView: Request body size exceeds the maximum allowed size",
        );
      }
      return serialized;
    } catch (err) {
      console.error("useMetricView: Failed to serialize request body", err);
      return null;
    }
  }, [args.measures, args.limit, format, maxParametersSize]);

  const start = useCallback(() => {
    if (payload === null) {
      setError("Failed to serialize metric request body");
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setLoading(true);
    setError(null);
    setData(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    connectSSE({
      url,
      payload,
      signal: abortController.signal,
      onMessage: async (message) => {
        try {
          const parsed = JSON.parse(message.data);

          if (parsed.type === "result") {
            setLoading(false);
            setData(parsed.data as ResultType[]);
            return;
          }

          if (parsed.type === "arrow") {
            // Arrow path is wired by the analytics route but Phase 1 of
            // metric views does not officially support ARROW (out-of-scope
            // per the PRD). Surface the absence as a clear error so apps
            // using a future ARROW path get a deterministic signal.
            setLoading(false);
            setError(
              "useMetricView: ARROW format is not supported at v1. Use format: 'JSON'.",
            );
            return;
          }

          if (parsed.type === "error" || parsed.error || parsed.code) {
            const errorMsg =
              parsed.error || parsed.message || "Unable to execute metric";
            setLoading(false);
            setError(errorMsg);
            if (parsed.code) {
              console.error(
                `[useMetricView] Code: ${parsed.code}, Message: ${errorMsg}`,
              );
            }
            return;
          }
        } catch (err) {
          console.warn("[useMetricView] Malformed message received", err);
        }
      },
      onError: (err) => {
        if (abortController.signal.aborted) return;
        setLoading(false);

        let userMessage = "Unable to load data, please try again";

        if (err instanceof Error) {
          if (err.name === "AbortError") {
            userMessage = "Request timed out, please try again";
          } else if (err.message.includes("Failed to fetch")) {
            userMessage = "Network error. Please check your connection.";
          }
          console.error("[useMetricView] Error", {
            metricKey,
            error: err.message,
            stack: err.stack,
          });
        }
        setError(userMessage);
      },
    });
  }, [metricKey, payload, url]);

  useEffect(() => {
    if (autoStart) {
      start();
    }
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [start, autoStart]);

  return { data, loading, error };
}
