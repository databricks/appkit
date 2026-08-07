import { ArrowClient, connectSSE } from "@/js";
import {
  type AnalyticsSseHandlerContext,
  GENERIC_LOAD_ERROR,
  handleAnalyticsSseError,
  handleAnalyticsSseMessage,
  userFacingFetchError,
} from "./analytics-sse";
import type { WarehouseStatus } from "./types";

/**
 * Shared in-flight request store for `useAnalyticsQuery`.
 *
 * Multiple hook instances that resolve to the same request (same query key,
 * parameters, format, and dev mode) share a single network request keyed by a
 * cache key. Each keyed {@link Entry} owns one transport (SSE or direct Arrow
 * fetch) and fans both the final result and mid-flight `warehouse_status`
 * updates out to every subscriber via `useSyncExternalStore`.
 *
 * SSE parsing and state transitions are shared with `useMetricView` via
 * `analytics-sse.ts`; this store adapts that handler's imperative
 * `setLoading`/`setError`/`onResult` callbacks onto its immutable per-key
 * snapshot + notify model.
 *
 * Dedup-only: a keyed entry lives exactly as long as it has subscribers. When
 * the last one releases, teardown is deferred a tick (so a StrictMode
 * unmount→remount reuses the in-flight request instead of aborting it); if no
 * one has re-subscribed by then, the request is aborted and the entry dropped.
 * There is no cross-lifecycle result cache.
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
export const EMPTY_SNAPSHOT: AnalyticsRequestSnapshot = {
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

interface Entry {
  snapshot: AnalyticsRequestSnapshot;
  refCount: number;
  abortController: AbortController | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  /** True once `start` has run at least once; guards re-run on late `retain`. */
  started: boolean;
  options: AnalyticsRequestOptions;
}

const entries = new Map<string, Entry>();

// Listeners are keyed independently of `entries` so a subscriber registered
// before its entry exists (React can call `useSyncExternalStore`'s subscribe
// before the `retain` effect runs) still receives notifications once the
// request starts.
const listenersByKey = new Map<string, Set<() => void>>();

function notify(key: string): void {
  const listeners = listenersByKey.get(key);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

/** Replace an entry's snapshot immutably and notify subscribers. */
function patch(
  key: string,
  entry: Entry,
  next: Partial<AnalyticsRequestSnapshot>,
): void {
  entry.snapshot = { ...entry.snapshot, ...next };
  notify(key);
}

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
  key: string,
  entry: Entry,
  signal: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch(entry.options.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: entry.options.payload,
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
      patch(key, entry, { loading: false, error: message, errorCode: code });
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
    patch(key, entry, { loading: false, data: table });
  } catch (error) {
    if (signal.aborted) return;
    patch(key, entry, { loading: false, error: userFacingFetchError(error) });
  }
}

/**
 * (Re)start the request for a keyed entry: abort any in-flight transport,
 * reset the snapshot to loading, and run the format-appropriate transport.
 * The new state fans out to every current subscriber.
 */
export function start(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;

  entry.abortController?.abort();

  entry.started = true;
  entry.snapshot = LOADING_SNAPSHOT;
  notify(key);

  const abortController = new AbortController();
  entry.abortController = abortController;
  const { signal } = abortController;

  // ARROW_STREAM: the server streams raw Arrow IPC bytes back on the query
  // response body (no SSE). Fetch and decode directly.
  if (entry.options.format === "ARROW_STREAM") {
    void fetchArrowDirect(key, entry, signal);
    return;
  }

  // Adapt the shared SSE handler's imperative callbacks onto this store's
  // snapshot+notify model. No warehouse publisher lives here — the hook
  // mirrors warehouse status into the resource-status provider from the
  // snapshot — so `unpublishWarehouseStatus` is a no-op.
  const sseContext: AnalyticsSseHandlerContext = {
    source: "useAnalyticsQuery",
    resource: { url: entry.options.url },
    defaultExecutionError: "Unable to execute query",
    unpublishOnMalformedMessage: false,
    signal,
    abort: () => abortController.abort(),
    setLoading: (loading) => patch(key, entry, { loading }),
    setError: (error) => patch(key, entry, { error }),
    setErrorCode: (errorCode) => patch(key, entry, { errorCode }),
    onWarehouseStatus: (status) =>
      patch(key, entry, { warehouseStatus: status }),
    onResult: (message) => patch(key, entry, { data: message.data }),
    unpublishWarehouseStatus: () => {},
  };

  connectSSE({
    url: entry.options.url,
    payload: entry.options.payload,
    signal,
    onMessage: (message) => handleAnalyticsSseMessage(message.data, sseContext),
    onError: (error) => handleAnalyticsSseError(error, sseContext),
  });
}

/**
 * Register a subscriber for `key`, creating and starting the shared request
 * on first use. Returns a `release` function that must be called on unmount.
 *
 * @param key      Cache key uniquely identifying the request.
 * @param options  Request options; only used when the entry is first created.
 * @param autoStart Whether to start the request on creation. Default true.
 */
export function retain(
  key: string,
  options: AnalyticsRequestOptions,
  autoStart = true,
): () => void {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      snapshot: EMPTY_SNAPSHOT,
      refCount: 0,
      abortController: null,
      teardownTimer: null,
      started: false,
      options,
    };
    entries.set(key, entry);
  }

  // A late joiner cancels any pending teardown so it keeps the live request.
  if (entry.teardownTimer !== null) {
    clearTimeout(entry.teardownTimer);
    entry.teardownTimer = null;
  }
  entry.refCount += 1;

  if (autoStart && !entry.started) {
    start(key);
  }

  return () => release(key);
}

function release(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;

  // Defer teardown one tick: a StrictMode unmount→remount (or a fast
  // route swap) re-`retain`s within the same tick and reuses the request.
  entry.teardownTimer = setTimeout(() => {
    const current = entries.get(key);
    if (!current || current.refCount > 0) return;
    current.abortController?.abort();
    entries.delete(key);
  }, 0);
}

export function subscribe(key: string, listener: () => void): () => void {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByKey.delete(key);
  };
}

export function getSnapshot(key: string): AnalyticsRequestSnapshot {
  return entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
}

/** Test-only: abort every in-flight request and clear the store. */
export function resetAnalyticsRequestStore(): void {
  for (const entry of entries.values()) {
    if (entry.teardownTimer !== null) clearTimeout(entry.teardownTimer);
    entry.abortController?.abort();
  }
  entries.clear();
  listenersByKey.clear();
}
