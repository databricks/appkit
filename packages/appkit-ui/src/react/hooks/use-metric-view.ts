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
  WarehouseStatus,
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
 *   orderBy, timeGrain/timeDimension, and limit
 * @returns Metric result state with typed rows, display metadata, and warehouse readiness
 *
 * @remarks
 * `orderBy` and `limit` interact. With `limit`, the route completes the ordering
 * with the remaining dimensions so the capped rows are the *same* rows on every
 * run — pass `orderBy` to choose WHICH rows (top-N), since the completion only
 * makes the result stable, not ranked. Without `limit`, `orderBy` is presentation
 * ordering over the full result and gets no completion.
 *
 * When a request refetches with the same metric key, measures, and dimensions,
 * the previous `data` and `metadata` remain available while `loading` is true.
 * Changing any of those result-shaping fields clears the previous result.
 *
 * @example
 * ```typescript
 * const { data, metadata } = useMetricView("orders", {
 *   measures: ["revenue"],
 *   dimensions: ["region"],
 *   filter: { member: "region", operator: "in", values: ["EMEA", "APAC"] },
 *   orderBy: [{ field: "revenue", direction: "DESC" }],
 *   limit: 10,
 * });
 * // JSON_ARRAY preserves SQL scalar cells as strings and nullable columns as null:
 * // data: Array<{ revenue: string | null; region: string | null }> | null
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
  const autoStart = options.autoStart ?? true;
  const devMode = getDevMode();
  const urlSuffix = `/api/analytics/metric/${encodeURIComponent(key)}${devMode}`;

  type Rows = PickMetricRow<K, M, D>[];
  const [result, setResult] = useState<{
    shape: string;
    data: Rows;
    metadata: Record<string, MetricViewColumnDisplay> | undefined;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [warehouseStatus, setWarehouseStatus] =
    useState<WarehouseStatus | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestKeyRef = useRef<string | null>(null);
  const effectLeaseRef = useRef(0);
  const requestedShapeRef = useRef<string | null>(null);

  const publisherId = useId();
  const {
    publish: publishWarehouseStatus,
    unpublish: unpublishWarehouseStatus,
  } = useAnalyticsWarehousePublisher(publisherId, key);

  if (!key || key.trim().length === 0) {
    throw new Error("useMetricView: 'key' must be a non-empty string.");
  }

  // Stringify to compare request by value; prevent re-firing on every render.
  const payload = useMemo(() => {
    const body: {
      measures: ReadonlyArray<unknown>;
      dimensions?: ReadonlyArray<unknown>;
      filter?: unknown;
      timeGrain?: unknown;
      timeDimension?: unknown;
      orderBy?: ReadonlyArray<unknown>;
      limit?: number;
    } = { measures: options.measures };
    if (options.dimensions !== undefined) body.dimensions = options.dimensions;
    if (options.filter !== undefined) body.filter = options.filter;
    if (options.timeGrain !== undefined) body.timeGrain = options.timeGrain;
    if (options.timeDimension !== undefined)
      body.timeDimension = options.timeDimension;
    if (options.orderBy !== undefined) body.orderBy = options.orderBy;
    if (options.limit !== undefined) body.limit = options.limit;
    return JSON.stringify(body);
  }, [
    options.measures,
    options.dimensions,
    options.filter,
    options.timeGrain,
    options.timeDimension,
    options.orderBy,
    options.limit,
  ]);

  // Detect shape changes: clear rows when metric/measures/dimensions change,
  // but keep stale rows during filter/order/limit/time-grain revalidations.
  const resultShape = JSON.stringify({
    key,
    measures: options.measures,
    dimensions: options.dimensions ?? [],
  });
  const requestKey = `${urlSuffix}\0${payload}`;

  // Return stale rows only if shape is current; hide during shape transitions.
  const isCurrentShape = result?.shape === resultShape;
  const data = isCurrentShape ? result.data : null;
  const metadata = isCurrentShape ? result.metadata : undefined;

  const start = useCallback(() => {
    abortControllerRef.current?.abort();

    setLoading(true);
    setError(null);
    setErrorCode(null);
    setWarehouseStatus(null);
    if (requestedShapeRef.current !== resultShape) {
      requestedShapeRef.current = resultShape;
      setResult(null);
    }
    // Register an empty slot to clear stale status from the prior run.
    publishWarehouseStatus(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    activeRequestKeyRef.current = requestKey;

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
      onWarehouseStatus: (status) => {
        setWarehouseStatus(status);
        publishWarehouseStatus(status);
      },
      onResult: (message) => {
        setError(null);
        setErrorCode(null);
        setResult({
          shape: resultShape,
          data: message.data as Rows,
          metadata: asMetricMetadata(message.payload.metadata),
        });
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
    requestKey,
    resultShape,
    urlSuffix,
    publishWarehouseStatus,
    unpublishWarehouseStatus,
  ]);

  useEffect(() => {
    const lease = ++effectLeaseRef.current;

    if (autoStart) {
      // React Strict Mode runs an effect's setup/cleanup/setup sequence on
      // mount. Keep the still-active identical stream for the second setup so
      // development sends one POST, not an immediately-aborted duplicate.
      // A real request change still starts synchronously and aborts the prior
      // controller in start().
      const activeController = abortControllerRef.current;
      if (
        activeRequestKeyRef.current !== requestKey ||
        !activeController ||
        activeController.signal.aborted
      ) {
        start();
      }
    } else {
      abortControllerRef.current?.abort();
      activeRequestKeyRef.current = null;
      unpublishWarehouseStatus();
    }

    return () => {
      // Defer teardown by one microtask so Strict Mode's immediate second
      // setup can claim the same request. On a genuine unmount there is no new
      // lease, so the stream is still cancelled before later async work runs.
      const controller = abortControllerRef.current;
      queueMicrotask(() => {
        if (effectLeaseRef.current !== lease) return;
        controller?.abort();
        if (abortControllerRef.current === controller) {
          activeRequestKeyRef.current = null;
        }
        unpublishWarehouseStatus();
      });
    };
  }, [start, autoStart, requestKey, unpublishWarehouseStatus]);

  useQueryHMR(key, start);

  return { data, loading, error, errorCode, metadata, warehouseStatus };
}
