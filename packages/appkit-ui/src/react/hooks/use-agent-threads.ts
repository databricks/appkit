import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "shared";

const DEFAULT_BASE_PATH = "/api/agents";

/** Wire shape of a summary — dates arrive as ISO strings over JSON. */
interface WireThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

function reviveSummary(s: WireThreadSummary): ThreadSummary {
  return {
    id: s.id,
    title: s.title,
    messageCount: s.messageCount,
    createdAt: new Date(s.createdAt),
    updatedAt: new Date(s.updatedAt),
  };
}

export interface UseAgentThreadsOptions {
  /**
   * Base path the agents plugin is mounted under. Default `"/api/agents"`.
   * The hook calls `GET/DELETE/PATCH {basePath}/threads[/:id]`.
   */
  basePath?: string;
}

export interface UseAgentThreadsResult {
  /** Summaries for the current user, most-recently-updated first. */
  threads: ThreadSummary[];
  /** True while the initial load or a `refetch()` is in flight. */
  loading: boolean;
  /** Last error message, or null. */
  error: string | null;
  /** Re-fetch the list (call after a turn completes to reflect new/updated threads). */
  refetch: () => Promise<void>;
  /** Delete a thread. Removes it optimistically; reconciles from the server on failure. */
  deleteThread: (threadId: string) => Promise<void>;
  /** Rename a thread. Updates the title optimistically; reconciles on failure. */
  renameThread: (threadId: string, title: string) => Promise<void>;
}

/**
 * Lists the current user's agent threads for a history sidebar. Reads the cheap
 * summary projection from `GET {basePath}/threads` (no message bodies) and
 * offers delete/rename. Sibling to {@link useAgentChat}: it owns the list, not
 * the active conversation — compose the two at the page level.
 *
 * Threads are scoped to the request's user server-side (via `x-forwarded-user`
 * / the dev fallback), so the hook sends no user identity itself.
 *
 * @example
 * ```tsx
 * const { threads, deleteThread, refetch } = useAgentThreads();
 * // <ThreadList> wraps this; or render `threads` yourself.
 * ```
 */
export function useAgentThreads(
  options: UseAgentThreadsOptions = {},
): UseAgentThreadsResult {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/threads`, { signal: ac.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { threads?: WireThreadSummary[] };
      if (ac.signal.aborted) return;
      setThreads((data.threads ?? []).map(reviveSummary));
    } catch (err) {
      if (ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load threads");
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [basePath]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      // Optimistic: drop it now, reconcile from the server if the call fails.
      const prev = threads;
      setThreads((list) => list.filter((t) => t.id !== threadId));
      try {
        const res = await fetch(
          `${basePath}/threads/${encodeURIComponent(threadId)}`,
          { method: "DELETE" },
        );
        if (!res.ok && res.status !== 404) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        setThreads(prev); // rollback already reconciles to the known-good list
        setError(
          err instanceof Error ? err.message : "Failed to delete thread",
        );
      }
    },
    [basePath, threads],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      const prev = threads;
      setThreads((list) =>
        list.map((t) => (t.id === threadId ? { ...t, title } : t)),
      );
      try {
        const res = await fetch(
          `${basePath}/threads/${encodeURIComponent(threadId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        setThreads(prev); // rollback already reconciles to the known-good list
        setError(
          err instanceof Error ? err.message : "Failed to rename thread",
        );
      }
    },
    [basePath, threads],
  );

  // Initial load + reload when the base path changes.
  useEffect(() => {
    void refetch();
    return () => abortRef.current?.abort();
  }, [refetch]);

  return { threads, loading, error, refetch, deleteThread, renameThread };
}
