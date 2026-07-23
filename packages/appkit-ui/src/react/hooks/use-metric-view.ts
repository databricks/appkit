import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetricColumnMeta } from "shared";
import { connectSSE } from "@/js";
import type {
  InferMetricRow,
  MetricKey,
  UseMetricViewOptions,
  UseMetricViewResult,
} from "./types";
import { useQueryHMR } from "./use-query-hmr";

function getDevMode(): string {
  const dev = new URL(window.location.href).searchParams.get("dev");
  return dev ? `?dev=${dev}` : "";
}

const GENERIC_LOAD_ERROR = "Unable to load data, please try again";

/** Map a fetch/SSE transport error to a user-facing message. */
function userFacingFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Request timed out, please try again";
    }
    if (error.message.includes("Failed to fetch")) {
      return "Network error. Please check your connection.";
    }
  }
  return GENERIC_LOAD_ERROR;
}

interface MetricSseContext {
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setErrorCode: (code: string | null) => void;
  setData: (data: Record<string, unknown>[] | null) => void;
  setMetadata: (metadata: Record<string, MetricColumnMeta> | undefined) => void;
}

function handleMetricSseMessage(
  parsed: Record<string, unknown>,
  ctx: MetricSseContext,
): void {
  // Warehouse-readiness progress. The metric result type does NOT expose
  // warehouseStatus (Phase 0 contract), so these events keep the hook in its
  // loading state without surfacing anything to the caller.
  if (parsed.type === "warehouse_status") {
    return;
  }

  // JSON result. The SSE wire schema is intentionally loose (`data` is an
  // optional array of unknown values), so a structural check is enough here —
  // no need to ship a schema validator (zod, ~60 KB gz) to the browser just
  // to read our own same-origin server's messages. Missing or non-array
  // `data` normalizes to [] so `undefined` never bleeds into the hook's
  // `T | null` state. `metadata` (per-column display metadata scoped to the
  // queried columns) is surfaced as-is, or `undefined` when the server
  // injected none (dormant / unknown key).
  if (parsed.type === "result") {
    ctx.setLoading(false);
    ctx.setData(Array.isArray(parsed.data) ? parsed.data : []);
    ctx.setMetadata(
      parsed.metadata as Record<string, MetricColumnMeta> | undefined,
    );
    return;
  }

  if (parsed.type === "error" || parsed.error || parsed.code) {
    const errorMsg =
      (parsed.error as string | undefined) ||
      (parsed.message as string | undefined) ||
      "Unable to execute metric query";
    ctx.setLoading(false);
    ctx.setError(errorMsg);
    // Propagate the upstream structured code so UI consumers can branch on a
    // stable identifier instead of parsing the human-readable message.
    if (typeof parsed.errorCode === "string") {
      ctx.setErrorCode(parsed.errorCode);
    }
    if (parsed.code) {
      console.error(
        `[useMetricView] Code: ${parsed.code}, Message: ${errorMsg}`,
      );
    }
    return;
  }

  // Not a warehouse-status, result, or error event — surface a generic error
  // rather than silently dropping an unrecognized payload.
  console.error("[useMetricView] Unrecognized SSE payload", parsed);
  ctx.setLoading(false);
  ctx.setError(GENERIC_LOAD_ERROR);
}

/**
 * Subscribe to a Unity Catalog metric view and return its latest result.
 * POSTs the structured `{ measures, dimensions, filter, timeGrain,
 * timeDimension, limit }` body to `POST /api/analytics/metric/:key` and
 * streams the row result back over SSE (with warehouse-readiness progress),
 * mirroring {@link useAnalyticsQuery}'s JSON_ARRAY path.
 *
 * The measure/dimension names, time grain, and row shape are inferred from the
 * `MetricRegistry` module augmentation when `key` is a known metric key.
 *
 * @param key - Metric view identifier
 * @param options - Measures (required) plus optional dimensions, filter,
 *   timeGrain/timeDimension, limit, and autoStart
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
export function useMetricView<K extends MetricKey = MetricKey>(
  key: K,
  options: UseMetricViewOptions<K>,
): UseMetricViewResult<InferMetricRow<K>[]> {
  const autoStart = options?.autoStart ?? true;

  const devMode = getDevMode();
  const urlSuffix = `/api/analytics/metric/${encodeURIComponent(key)}${devMode}`;

  type Rows = InferMetricRow<K>[];
  const [data, setData] = useState<Rows | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<
    Record<string, MetricColumnMeta> | undefined
  >(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);

  if (!key || key.trim().length === 0) {
    throw new Error("useMetricView: 'key' must be a non-empty string.");
  }

  // Serialize the request body from only the defined fields. A JSON string is
  // a primitive, so a structurally-equal body across renders stays
  // referentially stable for the `start` callback's dependency check even
  // though the caller passes fresh `measures`/`filter` object literals each
  // render — no manual deep-equality/ref juggling required.
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

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const sseContext: MetricSseContext = {
      setLoading,
      setError,
      setErrorCode,
      setData: (rows) => setData(rows as Rows | null),
      setMetadata,
    };

    connectSSE({
      url: urlSuffix,
      payload,
      signal: abortController.signal,
      onMessage: async (message) => {
        // Drop late envelopes from a stream whose controller was already
        // aborted (React StrictMode unmount→remount). Mirrors onError below.
        if (abortController.signal.aborted) return;
        try {
          const parsed = JSON.parse(message.data) as Record<string, unknown>;
          handleMetricSseMessage(parsed, sseContext);
        } catch (error) {
          // A `JSON.parse` failure (or any other thrown error inside the SSE
          // message handler) must not strand the hook in `loading=true` with
          // no error surfaced — the UI would spin forever. Clear loading,
          // report a user-facing error, and abort the stream so a broken
          // upstream doesn't re-fire the same failure on every frame.
          console.warn("[useMetricView] Malformed message received", error);
          setLoading(false);
          setError(GENERIC_LOAD_ERROR);
          abortController.abort();
        }
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        setLoading(false);

        if (error instanceof Error) {
          console.error("[useMetricView] Error", {
            key,
            error: error.message,
            stack: error.stack,
          });
        }
        setError(userFacingFetchError(error));
      },
    });
  }, [key, payload, urlSuffix]);

  useEffect(() => {
    if (autoStart) {
      start();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [start, autoStart]);

  useQueryHMR(key, start);

  return { data, loading, error, errorCode, metadata };
}
