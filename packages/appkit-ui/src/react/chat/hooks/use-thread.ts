import { useCallback, useEffect, useRef, useState } from "react";
import type { Thread } from "shared";
import {
  fetchJson,
  type HeadersOption,
  reviveThread,
  type SerializedThread,
} from "./internal/fetch-json";

export interface UseThreadOptions {
  /** Base URL for the threads collection, e.g. `"/api/agents/threads"`. */
  api: string;
  /**
   * Thread id to load. `null` / `undefined` keeps the hook idle (no fetch),
   * which is what you want when no thread is selected yet.
   */
  threadId: string | null | undefined;
  /** Optional auth/extra headers. May be a function for async resolution. */
  headers?: HeadersOption;
}

export interface UseThreadResult {
  thread: Thread | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch the current thread. No-op when `threadId` is nullish. */
  refresh: () => Promise<void>;
}

/**
 * Fetches `GET ${api}/${threadId}` and returns the thread (including its
 * `messages` array). Idle when `threadId` is nullish — `thread`/`error`
 * are cleared, no fetch. Any non-2xx response surfaces as a raw `Error`
 * on `error`.
 */
export function useThread(options: UseThreadOptions): UseThreadResult {
  const { api, threadId } = options;

  const headersRef = useRef(options.headers);
  headersRef.current = options.headers;

  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchThread = useCallback(async () => {
    if (!threadId) {
      abortRef.current?.abort();
      setThread(null);
      setError(null);
      setLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const url = `${api}/${encodeURIComponent(threadId)}`;
      const data = await fetchJson<SerializedThread>(url, {
        signal: controller.signal,
        headers: headersRef.current,
      });
      if (controller.signal.aborted) return;
      setThread(reviveThread(data));
      setLoading(false);
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err as Error | undefined)?.name === "AbortError"
      ) {
        return;
      }
      setThread(null);
      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
    }
  }, [api, threadId]);

  useEffect(() => {
    fetchThread();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchThread]);

  return { thread, loading, error, refresh: fetchThread };
}
