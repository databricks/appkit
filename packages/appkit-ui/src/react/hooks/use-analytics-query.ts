import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import * as store from "./analytics-request-store";
import { getDevMode } from "./analytics-sse";
import type {
  AnalyticsFormat,
  InferParams,
  InferResultByFormat,
  QueryKey,
  UseAnalyticsQueryOptions,
  UseAnalyticsQueryResult,
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

/**
 * Subscribe to an analytics query and return its latest result. JSON_ARRAY
 * results stream over SSE (with warehouse-readiness progress); ARROW_STREAM
 * results are fetched as raw Arrow bytes directly from the query endpoint.
 * Integration hook between client and analytics plugin.
 *
 * Identical requests (same query key, parameters, format, and dev mode) share
 * a single in-flight network request: the first mounting instance starts it,
 * later instances subscribe to the same {@link store} entry and see the same
 * result and warehouse-status updates. The request is torn down once its last
 * subscriber unmounts.
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
 * @example JSON_ARRAY format (default)
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params);
 * // data: Array<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 *
 * @example ARROW_STREAM format
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

  // Cache key shared across hook instances. `payload` already serializes
  // `{ parameters, format }`, so identical requests collapse to one key.
  // On a serialization failure (`payload === null`) the key stays unused: no
  // request is retained and the store reports the stable idle snapshot.
  const cacheKey = `${urlSuffix}::${payload}`;

  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(cacheKey, listener),
    [cacheKey],
  );
  const getSnapshot = useCallback(
    () => store.getSnapshot(cacheKey),
    [cacheKey],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const start = useCallback(() => store.start(cacheKey), [cacheKey]);

  // Register with the shared store on mount / key change; release on cleanup.
  // The store starts the request on first retain of a key and reuses the
  // in-flight request for later subscribers.
  useEffect(() => {
    if (payload === null) return;
    return store.retain(
      cacheKey,
      { url: urlSuffix, payload, format },
      autoStart,
    );
  }, [cacheKey, urlSuffix, payload, format, autoStart]);

  // Mirror this instance's warehouse status into the nearest resource-status
  // provider while the request is in flight; clear the slot once it settles.
  useEffect(() => {
    if (snapshot.loading) {
      publishWarehouseStatus(snapshot.warehouseStatus);
    } else {
      unpublishWarehouseStatus();
    }
  }, [
    snapshot.loading,
    snapshot.warehouseStatus,
    publishWarehouseStatus,
    unpublishWarehouseStatus,
  ]);

  useEffect(() => unpublishWarehouseStatus, [unpublishWarehouseStatus]);

  useQueryHMR(queryKey, start);

  return {
    data: snapshot.data as ResultType | null,
    loading: snapshot.loading,
    // A serialization failure never creates a store entry, so surface it here.
    error:
      payload === null
        ? "Failed to serialize query parameters"
        : snapshot.error,
    errorCode: snapshot.errorCode,
    warehouseStatus: snapshot.warehouseStatus,
  };
}
