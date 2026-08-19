import { ArrowClient, connectSSE } from "@/js";
import {
  type AnalyticsSseHandlerContext,
  GENERIC_LOAD_ERROR,
  handleAnalyticsSseError,
  handleAnalyticsSseMessage,
  userFacingFetchError,
} from "./analytics-sse";
import {
  createRequestStore,
  type RequestControls,
  type RequestRunner,
} from "./request-store";
import type { WarehouseStatus } from "./types";

/**
 * Shared in-flight request store for `useAnalyticsQuery`: an instance of the
 * generic {@link createRequestStore} lifecycle wired to the analytics
 * transports. Multiple hook instances resolving to the same request (query
 * key, parameters, format, dev mode) share one network request and see the
 * same result and mid-flight `warehouse_status` updates.
 *
 * The lifecycle (dedup, refcount, deferred teardown) lives in the factory; this
 * module only supplies the snapshot shape and how a request runs — SSE via
 * `analytics-sse.ts` or a direct Arrow fetch.
 */

/** Options describing the request a keyed entry runs. */
interface AnalyticsRequestOptions {
  /** Full request URL (already includes the encoded query key and dev suffix). */
  url: string;
  /** Serialized `{ parameters, format }` body. */
  payload: string;
  /** Response format; selects the transport. */
  format: string;
}

/** Immutable per-key request state; mirrors the hook's public result shape. */
interface AnalyticsRequestSnapshot {
  data: unknown;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  warehouseStatus: WarehouseStatus | null;
}

/** Idle snapshot returned for keys with no live entry. Referentially stable. */
const EMPTY_SNAPSHOT: AnalyticsRequestSnapshot = {
  data: null,
  loading: false,
  error: null,
  errorCode: null,
  warehouseStatus: null,
};

/** Snapshot a request resets to when it (re)starts. */
const LOADING_SNAPSHOT: AnalyticsRequestSnapshot = {
  data: null,
  loading: true,
  error: null,
  errorCode: null,
  warehouseStatus: null,
};

type Controls = RequestControls<AnalyticsRequestSnapshot>;

/**
 * Fetch the real column names for a statement from the fallback endpoint,
 * used when a very wide schema's names didn't fit in the response header.
 * Returns undefined on any failure so decoding falls back to the raw Arrow
 * schema names.
 */
async function fetchArrowColumns(
  statementId: string,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  try {
    const res = await fetch(
      `/api/analytics/columns/${encodeURIComponent(statementId)}`,
      { signal },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { columns?: unknown };
    return Array.isArray(body.columns) ? (body.columns as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch an ARROW_STREAM query result as raw Arrow IPC bytes directly from
 * the query endpoint (no SSE, no second /arrow-result request) and decode
 * it into a Table. The server streams the bytes back as the POST response
 * body; errors before the first byte arrive as a JSON `{ error, errorCode }`.
 */
async function fetchArrowDirect(
  controls: Controls,
  options: AnalyticsRequestOptions,
): Promise<void> {
  const { signal } = controls;
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: options.payload,
      signal,
    });
    if (signal.aborted) return;

    if (!response.ok) {
      let message = GENERIC_LOAD_ERROR;
      let code: string | null = null;
      try {
        const body = (await response.json()) as {
          error?: string;
          errorCode?: string;
        };
        if (body.error) message = body.error;
        if (typeof body.errorCode === "string") code = body.errorCode;
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      controls.patch({ loading: false, error: message, errorCode: code });
      return;
    }

    const buffer = await response.arrayBuffer();
    if (signal.aborted) return;
    // Databricks encodes ARROW_STREAM columns positionally (col_0, …); the
    // server sends the real manifest names so we can relabel the decoded
    // Table (charts look columns up by name). Normally inline in the
    // `X-Appkit-Arrow-Columns` header; for very wide schemas the header
    // carries only a statement-id reference and we fetch the names.
    let columnNames: string[] | undefined;
    const header = response.headers.get("X-Appkit-Arrow-Columns");
    if (header) {
      try {
        columnNames = JSON.parse(decodeURIComponent(header));
      } catch {
        // Malformed header — fall back to the raw Arrow schema names.
      }
    } else {
      const ref = response.headers.get("X-Appkit-Arrow-Columns-Ref");
      if (ref) {
        columnNames = await fetchArrowColumns(ref, signal);
      }
    }
    const table = await ArrowClient.processArrowBuffer(
      new Uint8Array(buffer),
      columnNames,
    );
    controls.patch({ loading: false, data: table });
  } catch (error) {
    if (signal.aborted) return;
    controls.patch({ loading: false, error: userFacingFetchError(error) });
  }
}

/**
 * Build the runner for a request: reset to loading, then run the
 * format-appropriate transport, reporting state through `controls.patch`.
 */
function runAnalyticsRequest(
  options: AnalyticsRequestOptions,
): RequestRunner<AnalyticsRequestSnapshot> {
  return (controls) => {
    controls.patch(LOADING_SNAPSHOT);

    // ARROW_STREAM: the server streams raw Arrow IPC bytes back on the query
    // response body (no SSE). Fetch and decode directly.
    if (options.format === "ARROW_STREAM") {
      void fetchArrowDirect(controls, options);
      return;
    }

    // Adapt the shared SSE handler onto the snapshot model. No warehouse
    // publisher lives here — the hook mirrors status from the snapshot — so
    // `unpublishWarehouseStatus` is a no-op.
    const sseContext: AnalyticsSseHandlerContext = {
      source: "useAnalyticsQuery",
      resource: { url: options.url },
      defaultExecutionError: "Unable to execute query",
      unpublishOnMalformedMessage: false,
      signal: controls.signal,
      abort: controls.abort,
      setLoading: (loading) => controls.patch({ loading }),
      setError: (error) => controls.patch({ error }),
      setErrorCode: (errorCode) => controls.patch({ errorCode }),
      onWarehouseStatus: (status) =>
        controls.patch({ warehouseStatus: status }),
      onResult: (message) => controls.patch({ data: message.data }),
      unpublishWarehouseStatus: () => {},
    };

    connectSSE({
      url: options.url,
      payload: options.payload,
      signal: controls.signal,
      onMessage: (message) =>
        handleAnalyticsSseMessage(message.data, sseContext),
      onError: (error) => handleAnalyticsSseError(error, sseContext),
    });
  };
}

const store = createRequestStore<AnalyticsRequestSnapshot>(EMPTY_SNAPSHOT);

/**
 * Register a subscriber for `key`, starting the shared request on first use.
 * Returns a `release` function that must be called on unmount.
 */
export function retain(
  key: string,
  options: AnalyticsRequestOptions,
  autoStart = true,
): () => void {
  return store.retain(key, runAnalyticsRequest(options), autoStart);
}

export const start = store.start;
export const subscribe = store.subscribe;
export const getSnapshot = store.getSnapshot;

/** Test-only: abort every in-flight request and clear the store. */
export const resetAnalyticsRequestStore = store.reset;
