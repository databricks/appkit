import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MetricColumnMeta } from "shared";
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

/**
 * Narrow the wire `metadata` field to a per-column map. The value is only a
 * meaningful metadata map when it is a plain object; a `null`, array, or scalar
 * is treated as absent (`undefined`). Per-column shapes are not validated —
 * the server constructs them via the typed builder.
 */
function asMetricMetadata(
  value: unknown,
): Record<string, MetricColumnMeta> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, MetricColumnMeta>;
  }
  return undefined;
}

/**
 * Subscribe to a Unity Catalog metric view and return its latest result.
 * POSTs the structured `{ measures, dimensions, filter, timeGrain,
 * timeDimension, limit }` body to `POST /api/analytics/metric/:key` and
 * streams the row result back over SSE (with warehouse-readiness progress),
 * mirroring {@link useAnalyticsQuery}'s JSON_ARRAY path.
 *
 * The measure/dimension names, time grain, and row shape are inferred from the
 * `MetricRegistry` module augmentation when `key` is a known metric key. The
 * returned rows are narrowed to exactly the SELECTED measures/dimensions (not
 * every column the metric exposes).
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
    Record<string, MetricColumnMeta> | undefined
  >(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Warehouse-readiness status
  const publisherId = useId();
  const {
    publish: publishWarehouseStatus,
    unpublish: unpublishWarehouseStatus,
  } = useAnalyticsWarehousePublisher(publisherId, key);

  if (!key || key.trim().length === 0) {
    throw new Error("useMetricView: 'key' must be a non-empty string.");
  }

  // Serialize the request body from only the defined fields. A JSON string is
  // a primitive, so a body that serializes identically across renders stays
  // referentially stable for the `start` callback's dependency check even
  // though the caller passes fresh `measures`/`filter` object literals each
  // render — no manual deep-equality/ref juggling required. (Reordering keys
  // changes the serialization and does re-fire, but the field order here is
  // fixed and the caller does not control it.)
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
      // Metric results expose warehouse readiness only through the shared
      // resource-status publisher, not through UseMetricViewResult.
      onWarehouseStatus: publishWarehouseStatus,
      onResult: (message) => {
        // A successful result supersedes a prior retried error.
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
