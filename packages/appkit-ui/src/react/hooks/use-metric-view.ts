import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMetricMetadata } from "@/format";
import { connectSSE } from "@/js";
import type {
  AnalyticsFormat,
  DimensionKey,
  MeasureKey,
  MetricKey,
  MetricMetadata,
  UseMetricViewArgs,
  UseMetricViewOptions,
  UseMetricViewResult,
  UseMetricViewRow,
} from "./types";

/**
 * Module-level singleton — `new TextEncoder()` is cheap but constructing
 * one per byte-count call is still wasted allocation. The encoder is
 * stateless, so a single shared instance is safe.
 */
const TEXT_ENCODER = new TextEncoder();

/**
 * Subscribe to a metric-view query over SSE.
 *
 * Phase 5 surface — accepts `{ measures, dimensions?, timeGrain?, filter?, limit? }`.
 * The result row type narrows at the call site to
 * `Pick<MetricRow<K>, M[number] | D[number]>` based on the chosen measures
 * and dimensions, so chart code receives the exact shape it asked for.
 *
 * Returns `{ data, metadata, loading, error }`. The `metadata` field carries
 * the build-time-bundled semantic metadata for the queried metric (display
 * names, format specs, descriptions). `metadata` is available **before** the
 * data loads and is stable across re-renders for the same metric key.
 *
 * Use `as const` on the `measures` and `dimensions` arrays at the call site
 * to preserve literal types (the same pattern used elsewhere in AppKit for
 * registry-narrowed APIs).
 *
 * @example
 * ```tsx
 * const { data, metadata, loading, error } = useMetricView("revenue", {
 *   measures: ["arr"] as const,
 *   dimensions: ["region", "created_at"] as const,
 *   timeGrain: "month",
 * });
 * // data: Array<{ arr: number; region: string; created_at: string }> | null
 * // metadata.measures.arr.format → "$#,##0.00"
 * // metadata.measures.arr.display_name → "Annual Recurring Revenue"
 * ```
 */
export function useMetricView<
  K extends MetricKey = MetricKey,
  const M extends ReadonlyArray<MeasureKey<K>> = ReadonlyArray<MeasureKey<K>>,
  const D extends ReadonlyArray<DimensionKey<K>> = ReadonlyArray<
    DimensionKey<K>
  >,
  F extends AnalyticsFormat = "JSON",
>(
  metricKey: K,
  args: UseMetricViewArgs<K, M, D>,
  options: UseMetricViewOptions<F> = {} as UseMetricViewOptions<F>,
): UseMetricViewResult<UseMetricViewRow<K, M, D>, MetricMetadata<K>> {
  if (!metricKey || metricKey.trim().length === 0) {
    throw new Error("useMetricView: 'metricKey' must be a non-empty string.");
  }

  const format = options.format ?? "JSON";
  const autoStart = options.autoStart ?? true;
  const maxParametersSize = options.maxParametersSize ?? 100 * 1024;

  const url = `/api/analytics/metric/${encodeURIComponent(metricKey)}`;

  type ResultType = UseMetricViewRow<K, M, D>;
  const [data, setData] = useState<ResultType[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Read the build-time semantic-metadata bundle from the format registry.
  // The lookup is keyed only by `metricKey`, so the returned reference is
  // stable across re-renders for the same metric (the PRD's contract:
  // "metadata is stable, not reactive"). Memoizing here is also defense-
  // in-depth — even if a customer hot-reloads the metadata bundle, this hook
  // still returns the same object reference for the lifetime of the render
  // cycle.
  const metadata = useMemo(
    () => getMetricMetadata(metricKey) as MetricMetadata<K> | null,
    [metricKey],
  );

  // Stable serialization key — defends against consumers passing inline
  // `args` (new object every render) without `useMemo`. JSON.stringify runs
  // once per render and is bounded by `maxParametersSize`; the payload memo
  // (and the downstream effect) only re-fires when the request body actually
  // changes by content. Without this, every render with fresh references
  // would reset state and refetch, producing an infinite loop.
  const argsKey = JSON.stringify(args);

  // Hold the latest `args` in a ref so the payload memo can read fresh
  // values without listing each `args.*` field as a dep. The ref always
  // matches the closed-over `argsKey`: when content changes, both update
  // in the same render before the memo body runs.
  const argsRef = useRef(args);
  argsRef.current = args;

  // biome-ignore lint/correctness/useExhaustiveDependencies: argsKey is the trigger; args read via argsRef
  const payload = useMemo(() => {
    try {
      const a = argsRef.current;
      const dimensions = a.dimensions ? [...a.dimensions] : undefined;
      const body: Record<string, unknown> = {
        measures: [...a.measures],
        format,
      };
      if (dimensions && dimensions.length > 0) {
        body.dimensions = dimensions;
      }
      if (typeof a.timeGrain === "string" && a.timeGrain.length > 0) {
        body.timeGrain = a.timeGrain;
      }
      if (a.filter !== undefined) {
        // Filter is a recursive AND/OR/Predicate tree; preserve structure
        // verbatim — the server validates and translates it into SQL.
        body.filter = a.filter;
      }
      if (typeof a.limit === "number") {
        body.limit = a.limit;
      }
      const serialized = JSON.stringify(body);
      // Avoid the Blob allocation just to count bytes — it's a hot path
      // on dashboards with many metric tiles. `TextEncoder.encode()` is
      // O(n) over the serialized bytes (same big-O as Blob's internal
      // encoding) but skips the Blob wrapper allocation. The encoder is
      // hoisted to module scope so we don't allocate one per call either.
      const sizeInBytes = TEXT_ENCODER.encode(serialized).length;
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
  }, [argsKey, format, maxParametersSize]);

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
            const rawMsg =
              parsed.error || parsed.message || "Unable to execute metric";
            // Defense-in-depth: do not echo raw warehouse / server error
            // text (which can contain SQL fragments, FQNs, schema detail) to
            // the user in production. Dev mode keeps the passthrough so
            // developers can diagnose schema-not-found, auth-failed, etc.
            // The full message is still logged via console.error for ops.
            const userMsg = import.meta.env.DEV
              ? rawMsg
              : "Unable to execute metric";
            setLoading(false);
            setError(userMsg);
            if (parsed.code || rawMsg !== userMsg) {
              console.error(
                `[useMetricView] Code: ${parsed.code ?? "(none)"}, Message: ${rawMsg}`,
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
          } else if (import.meta.env.DEV && err.message) {
            // In dev, surface the actual error so developers can diagnose
            // schema-not-found, auth-failed, and other server-thrown
            // failures that didn't make it into an SSE error event.
            // Production keeps the generic message — the full error is
            // still in the console.error below for ops.
            userMessage = err.message;
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

  return { data, metadata, loading, error };
}
