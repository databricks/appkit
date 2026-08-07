import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MetricViewColumnDisplay } from "shared";
import { connectSSE } from "@/js";
import {
  type AnalyticsSseHandlerContext,
  getDevMode,
  handleAnalyticsSseError,
  handleAnalyticsSseMessage,
} from "./analytics-sse";
import type {
  InferDimensionKeys,
  InferMeasureKeys,
  MetricKey,
  PickMetricRow,
  UseMetricViewOptions,
  UseMetricViewResult,
} from "./types";
import { useAnalyticsWarehousePublisher } from "./use-analytics-warehouse-status";
import { useQueryHMR } from "./use-query-hmr";

function asMetricMetadata(
  value: unknown,
): Record<string, MetricViewColumnDisplay> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, MetricViewColumnDisplay>;
  }
  return undefined;
}

/**
 * Subscribe to a Unity Catalog Metric View and return its latest result.
 *
 * @param key - Metric view identifier
 * @param options - Measures (required) plus optional dimensions, filter,
 *   timeGrain/timeDimension, and limit
 * @returns Metric result state with typed rows and per-column display metadata
 *
 * @example
 * ```typescript
 * const { data, metadata } = useMetricView("orders", {
 *   measures: ["revenue"],
 *   dimensions: ["region"],
 *   filter: { member: "region", operator: "in", values: ["EMEA", "APAC"] },
 * });
 * // data: Array<{ revenue: number; region: string }> | null
 * ```
 */
export function useMetricView<
  K extends MetricKey = MetricKey,
  const M extends ReadonlyArray<InferMeasureKeys<K>> = ReadonlyArray<
    InferMeasureKeys<K>
  >,
  const D extends ReadonlyArray<InferDimensionKeys<K>> = readonly [],
>(
  key: K,
  options: UseMetricViewOptions<K, M, D>,
): UseMetricViewResult<PickMetricRow<K, M, D>[]> {
  const devMode = getDevMode();
  const urlSuffix = `/api/analytics/metric/${encodeURIComponent(key)}${devMode}`;

  type Rows = PickMetricRow<K, M, D>[];
  const [data, setData] = useState<Rows | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<
    Record<string, MetricViewColumnDisplay> | undefined
  >(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);

  const publisherId = useId();
  const {
    publish: publishWarehouseStatus,
    unpublish: unpublishWarehouseStatus,
  } = useAnalyticsWarehousePublisher(publisherId, key);

  if (!key || key.trim().length === 0) {
    throw new Error("useMetricView: 'key' must be a non-empty string.");
  }

  // Serialize the request body from only the defined fields. Keeping it a string
  // makes `start`'s dependency check compare the request by value, so callers
  // passing inline `measures`/`filter` literals don't re-fire the query on every
  // render just because the object identity changed.
  const payload = useMemo(() => {
    const body: {
      measures: ReadonlyArray<unknown>;
      dimensions?: ReadonlyArray<unknown>;
      filter?: unknown;
      timeGrain?: unknown;
      timeDimension?: unknown;
      limit?: number;
    } = { measures: options.measures };
    if (options.dimensions !== undefined) body.dimensions = options.dimensions;
    if (options.filter !== undefined) body.filter = options.filter;
    if (options.timeGrain !== undefined) body.timeGrain = options.timeGrain;
    if (options.timeDimension !== undefined)
      body.timeDimension = options.timeDimension;
    if (options.limit !== undefined) body.limit = options.limit;
    return JSON.stringify(body);
  }, [
    options.measures,
    options.dimensions,
    options.filter,
    options.timeGrain,
    options.timeDimension,
    options.limit,
  ]);

  const start = useCallback(() => {
    abortControllerRef.current?.abort();

    setLoading(true);
    setError(null);
    setErrorCode(null);
    setData(null);
    setMetadata(undefined);
    // Register this hook's slot (null = registered, not contributing) so a
    // re-query clears any stale warehouse status from the prior run.
    publishWarehouseStatus(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const sseContext: AnalyticsSseHandlerContext = {
      source: "useMetricView",
      resource: { key },
      defaultExecutionError: "Unable to execute metric query",
      unpublishOnMalformedMessage: true,
      signal: abortController.signal,
      abort: () => abortController.abort(),
      setLoading,
      setError,
      setErrorCode,
      onWarehouseStatus: publishWarehouseStatus,
      onResult: (message) => {
        setError(null);
        setErrorCode(null);
        setData(message.data as Rows);
        setMetadata(asMetricMetadata(message.payload.metadata));
      },
      unpublishWarehouseStatus,
    };

    connectSSE({
      url: urlSuffix,
      payload,
      signal: abortController.signal,
      onMessage: (message) =>
        handleAnalyticsSseMessage(message.data, sseContext),
      onError: (error) => handleAnalyticsSseError(error, sseContext),
    });
  }, [
    key,
    payload,
    urlSuffix,
    publishWarehouseStatus,
    unpublishWarehouseStatus,
  ]);

  useEffect(() => {
    start();

    return () => {
      abortControllerRef.current?.abort();
      unpublishWarehouseStatus();
    };
  }, [start, unpublishWarehouseStatus]);

  useQueryHMR(key, start);

  return { data, loading, error, errorCode, metadata };
}
