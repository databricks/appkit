import { useCallback, useEffect, useRef, useState } from "react";
import type { Thread } from "shared";
import {
  fetchJson,
  type HeadersOption,
  reviveThread,
  type SerializedThread,
} from "./internal/fetch-json";

export interface UseThreadListOptions {
  /** Base URL for the threads collection, e.g. `"/api/agents/threads"`. */
  api: string;
  /** Optional auth/extra headers. May be a function for async resolution. */
  headers?: HeadersOption;
  /**
   * When `false`, the hook does not fetch (useful while auth context loads).
   * Defaults to `true`.
   */
  enabled?: boolean;
}

export interface UseThreadListResult {
  threads: Thread[] | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch the list. Cancels any in-flight request first. */
  refresh: () => Promise<void>;
}

/**
 * Fetches `GET ${api}` and returns the list of threads for the current user.
 *
 * Auto-runs on mount and whenever `api` or `enabled` changes. Cancels the
 * in-flight request on unmount or when a new fetch starts.
 */
export function useThreadList(
  options: UseThreadListOptions,
): UseThreadListResult {
  const { api, enabled = true } = options;

  const headersRef = useRef(options.headers);
  headersRef.current = options.headers;

  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchList = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ threads: SerializedThread[] }>(api, {
        signal: controller.signal,
        headers: headersRef.current,
      });
      if (controller.signal.aborted) return;
      setThreads(data.threads.map(reviveThread));
      setLoading(false);
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err as Error | undefined)?.name === "AbortError"
      ) {
        return;
      }
      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
    }
  }, [api, enabled]);

  useEffect(() => {
    fetchList();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchList]);

  return { threads, loading, error, refresh: fetchList };
}
