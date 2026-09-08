import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAgentChat } from "./use-agent-chat";

const DEFAULT_BASE_PATH = "/api/agents";
const STREAMING_ID = "__streaming__";

/** A message rendered in a thread transcript. */
export interface AgentThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** Wire shape of a persisted message from `GET {basePath}/threads/:id`. */
interface WireMessage {
  id: string;
  role: string;
  content: string;
}

export interface UseAgentThreadOptions {
  /** Agent to route turns to (registered with the `agents()` plugin). */
  agent: string;
  /** Base path the agents plugin is mounted under. Default `"/api/agents"`. */
  basePath?: string;
  /**
   * Mirror the active thread id in the URL query so a reload resumes it.
   * Default `false` — AppKit apps usually own their router. When `true`, the
   * hook reads the param on mount (if no `threadId` was passed) and writes it
   * on change; an explicit `threadId` argument always wins.
   */
  persistInUrl?: boolean;
  /** Query param used when `persistInUrl` is on. Default `"threadId"`. */
  urlParamName?: string;
}

export interface UseAgentThreadResult {
  /** The transcript: loaded history + completed turns + the live streaming turn. */
  messages: AgentThreadMessage[];
  /** Active thread id (the resumed id, or the server-assigned id after the first send). */
  threadId: string | null;
  /** True while loading a thread's history. */
  loading: boolean;
  /** True while an assistant turn is streaming. */
  isStreaming: boolean;
  /** History-load or streaming error message, or null. */
  error: string | null;
  /** Send a user turn; continues this thread (or creates one on the first send). */
  send: (text: string) => Promise<void>;
  /** Clear the transcript and start a fresh thread. */
  reset: () => void;
}

function readUrlThreadId(param: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get(param) ?? undefined;
}

/**
 * Owns one agent conversation's transcript: loads history for an existing
 * thread, streams new turns (built on {@link useAgentChat}), and appends each
 * completed turn. The "active thread" counterpart to {@link useAgentThreads}
 * (the list) — compose them at the page level.
 *
 * Pass a `threadId` to resume a persisted thread, or omit it for a fresh one
 * whose id the server assigns on the first `send()` (surfaced via
 * {@link UseAgentThreadResult.threadId}).
 *
 * @example
 * ```tsx
 * const { messages, send, isStreaming } = useAgentThread(activeId, { agent: "helper" });
 * ```
 */
export function useAgentThread(
  threadId?: string,
  options: UseAgentThreadOptions = { agent: "" },
): UseAgentThreadResult {
  const { agent, persistInUrl = false } = options;
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const urlParam = options.urlParamName ?? "threadId";

  // The id to resume: explicit arg wins, else the URL (when persisting), else none.
  const [resumeId, setResumeId] = useState<string | undefined>(() =>
    threadId !== undefined
      ? threadId
      : persistInUrl
        ? readUrlThreadId(urlParam)
        : undefined,
  );
  // An explicit threadId argument always wins and re-seeds on change.
  useEffect(() => {
    if (threadId !== undefined) setResumeId(threadId);
  }, [threadId]);

  const [committed, setCommitted] = useState<AgentThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const {
    content,
    threadId: activeThreadId,
    isStreaming,
    error: streamError,
    send: chatSend,
    reset: chatReset,
  } = useAgentChat({
    agent,
    endpoint: `${basePath}/chat`,
    initialThreadId: resumeId,
  });

  // Load history whenever the resume target changes (a fresh id, or a switch).
  useEffect(() => {
    if (!resumeId) {
      setCommitted([]);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setHistoryError(null);
    fetch(`${basePath}/threads/${encodeURIComponent(resumeId)}`, {
      signal: ac.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ messages?: WireMessage[] }>;
      })
      .then((thread) => {
        if (ac.signal.aborted) return;
        setCommitted(
          (thread.messages ?? [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              id: m.id,
              role: m.role as AgentThreadMessage["role"],
              content: m.content,
            })),
        );
        setLoading(false);
      })
      .catch((err: Error) => {
        if (ac.signal.aborted) return;
        setHistoryError(err.message || "Failed to load thread");
        setLoading(false);
      });
    return () => ac.abort();
  }, [resumeId, basePath]);

  // Commit the assistant turn once streaming ends (true -> false transition).
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming && content) {
      setCommitted((prev) => [
        ...prev,
        { id: `a-${prev.length}-${Date.now()}`, role: "assistant", content },
      ]);
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, content]);

  // Reflect the active thread id in the URL when persisting.
  useEffect(() => {
    if (!persistInUrl || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (activeThreadId) params.set(urlParam, activeThreadId);
    else params.delete(urlParam);
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
  }, [persistInUrl, urlParam, activeThreadId]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setCommitted((prev) => [
        ...prev,
        {
          id: `u-${prev.length}-${Date.now()}`,
          role: "user",
          content: trimmed,
        },
      ]);
      await chatSend(trimmed);
    },
    [chatSend],
  );

  const reset = useCallback(() => {
    setCommitted([]);
    setHistoryError(null);
    setResumeId(undefined);
    chatReset();
  }, [chatReset]);

  // Show the in-progress assistant turn as a live bubble once it has text.
  // Before the first token, `isStreaming` alone signals "thinking" — no empty
  // bubble. On completion the turn is committed above, so this reconciles
  // seamlessly.
  const messages = useMemo<AgentThreadMessage[]>(
    () =>
      isStreaming && content
        ? [...committed, { id: STREAMING_ID, role: "assistant", content }]
        : committed,
    [committed, isStreaming, content],
  );

  return {
    messages,
    threadId: activeThreadId,
    loading,
    isStreaming,
    error: historyError ?? streamError,
    send,
    reset,
  };
}
