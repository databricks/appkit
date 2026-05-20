import { useCallback, useRef, useState } from "react";
import { type HeadersOption, mutateJson } from "./internal/fetch-json";

export interface UseDeleteThreadOptions {
  /** Base URL for the threads collection, e.g. `"/api/agents/threads"`. */
  api: string;
  /** Optional auth/extra headers. May be a function for async resolution. */
  headers?: HeadersOption;
}

export interface UseDeleteThreadResult {
  /**
   * Issues `DELETE ${api}/${encodeURIComponent(id)}`. Resolves once the
   * server confirms the delete; rejects with a plain `Error` on non-2xx
   * (message taken from the server's `error` field when present).
   */
  deleteThread: (id: string) => Promise<void>;
  /** True while a `deleteThread()` call is in flight. */
  loading: boolean;
  /** Last rejection from `deleteThread()`. Cleared at the next call. */
  error: Error | null;
}

/**
 * Mutation hook for `DELETE /threads/:id` against an `agents()`-backed
 * AppKit server. Mirrors the request/response contract of the
 * companion read hooks (`useThread`, `useThreadList`) so the chat UI
 * can coordinate delete + list-refresh without re-implementing fetch
 * plumbing in components.
 */
export function useDeleteThread(
  options: UseDeleteThreadOptions,
): UseDeleteThreadResult {
  const { api } = options;

  // Ref'd so consumers can pass inline header objects without
  // destabilising the returned callback.
  const headersRef = useRef(options.headers);
  headersRef.current = options.headers;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const deleteThread = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        await mutateJson(`${api}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: headersRef.current,
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setLoading(false);
        throw e;
      }
      setLoading(false);
    },
    [api],
  );

  return { deleteThread, loading, error };
}
