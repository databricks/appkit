import { useCallback, useEffect, useRef, useState } from "react";
import { connectSSE } from "@/js";

/**
 * One Responses-API-shaped event yielded by the agents plugin SSE stream.
 *
 * The hook handles the two paths every chat UI needs — accumulating
 * `content` from `response.output_text.delta` and capturing `threadId`
 * from `appkit.metadata` — and surfaces everything else (tool calls,
 * approval gates, status events, etc.) through {@link UseAgentChatOptions.onEvent}.
 *
 * Fields beyond `type` are intentionally loose because the agents plugin
 * forwards adapter-specific shapes verbatim. Treat unknown fields as
 * opaque pass-through.
 */
export interface AgentChatEvent {
  type: string;
  delta?: string;
  item_id?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: string;
    status?: string;
  };
  content?: string;
  data?: Record<string, unknown>;
  error?: string;
  sequence_number?: number;
  output_index?: number;
  // `appkit.approval_pending` payload
  approval_id?: string;
  stream_id?: string;
  tool_name?: string;
  args?: unknown;
  annotations?: Record<string, unknown>;
}

export interface UseAgentChatOptions {
  /**
   * Agent name registered with the `agents()` plugin (e.g. `"assistant"`,
   * `"helper"`). Send-time payload includes this so the plugin routes the
   * turn to the right `AgentDefinition`.
   */
  agent: string;
  /**
   * Override the chat endpoint. Default `"/api/agents/chat"` matches the
   * route the agents plugin mounts under its prefix. Useful when the
   * server mounts under a non-default base path or when proxying.
   */
  endpoint?: string;
  /**
   * Called for every parsed SSE event before any state update. Use this
   * to drive tool-call rows, approval cards, inspectors, or anything
   * beyond the streaming text content. Errors thrown here are swallowed
   * so a buggy handler can't kill the stream.
   */
  onEvent?: (event: AgentChatEvent) => void;
}

export interface UseAgentChatResult {
  /** Accumulated assistant text from `response.output_text.delta` events. */
  content: string;
  /**
   * Every parsed event, in order. Provided for components that need to
   * render historical tool calls or replay state after a remount —
   * lighter than re-deriving from message history. For one-off side
   * effects prefer {@link UseAgentChatOptions.onEvent}.
   */
  events: AgentChatEvent[];
  /**
   * Thread id captured from the first `appkit.metadata` event of the
   * stream. Subsequent `send()` calls automatically forward this so the
   * server reuses the same thread.
   */
  threadId: string | null;
  /** True while an SSE stream is open. */
  isStreaming: boolean;
  /** Last error message (cleared on next successful `send()`). */
  error: string | null;
  /**
   * Send a user turn and stream the response. Aborts any in-flight
   * stream. Resolves when the stream completes (success or error).
   */
  send: (message: string) => Promise<void>;
  /**
   * Discard accumulated content, events, and threadId. Aborts any
   * in-flight stream. Use when switching agents or starting a fresh
   * conversation.
   */
  reset: () => void;
}

/**
 * React hook for chatting with an agent registered via the `agents()`
 * plugin. Wraps {@link connectSSE} (which owns the buffer cap, abort
 * composition, retry/backoff, and frame parsing) with the small amount
 * of stateful glue every chat UI needs: accumulated assistant text,
 * thread id, streaming flag, and an event callback.
 *
 * The hook is intentionally lower-level than a full chat component —
 * it owns one stream at a time, not a multi-turn message history. The
 * caller composes its own messages array (typically a `useState`) and
 * appends to it via the `onEvent` callback for tool calls and via the
 * `content` field for assistant text.
 *
 * @example
 * ```tsx
 * function Chat({ agent }: { agent: string }) {
 *   const [messages, setMessages] = useState<Message[]>([]);
 *   const { content, threadId, isStreaming, send, reset } = useAgentChat({
 *     agent,
 *     onEvent(ev) {
 *       if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
 *         setMessages((m) => [...m, { role: "tool", name: ev.item?.name, args: ev.item?.arguments }]);
 *       }
 *     },
 *   });
 *   // `content` reflects the latest assistant turn; reset() between conversations.
 *   // ...
 * }
 * ```
 */
export function useAgentChat({
  agent,
  endpoint = "/api/agents/chat",
  onEvent,
}: UseAgentChatOptions): UseAgentChatResult {
  const [content, setContent] = useState("");
  const [events, setEvents] = useState<AgentChatEvent[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs avoid the standard "stale closure" problem with `send` and
  // `onEvent`: `send` is a stable callback that reads the latest
  // threadId/onEvent without re-mounting connectSSE on every render.
  const threadIdRef = useRef<string | null>(null);
  const contentRef = useRef("");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const abortControllerRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    threadIdRef.current = null;
    contentRef.current = "";
    setContent("");
    setEvents([]);
    setThreadId(null);
    setIsStreaming(false);
    setError(null);
  }, []);

  const send = useCallback(
    async (message: string) => {
      // Abort any previous stream — only one chat turn in flight per hook.
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      contentRef.current = "";
      setContent("");
      setEvents([]);
      setError(null);
      setIsStreaming(true);

      const payload = {
        message,
        agent,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
      };

      try {
        await connectSSE({
          url: endpoint,
          payload,
          signal: controller.signal,
          // Chat turns aren't idempotent — re-sending the payload after a
          // transient failure would either duplicate the user message or
          // depend on server-side Last-Event-ID resumption (the agents
          // plugin's StreamManager supports it, but failure-mode auditing
          // is easier with retries off by default; callers can re-enable
          // via the underlying connectSSE once they understand the
          // resumption contract on their endpoint).
          maxRetries: 0,
          onMessage: async ({ data }) => {
            if (controller.signal.aborted) return;
            if (!data || data === "[DONE]") return;
            let event: AgentChatEvent;
            try {
              event = JSON.parse(data) as AgentChatEvent;
            } catch {
              // Skip malformed payloads — the rest of the stream is
              // still useful and the agents plugin recovers on the
              // next event boundary.
              return;
            }
            if (!event.type) return;

            // Best-effort: never let an onEvent throw break the stream.
            try {
              onEventRef.current?.(event);
            } catch {
              // swallow
            }

            setEvents((prev) => [...prev, event]);

            if (event.type === "appkit.metadata") {
              const tid = event.data?.threadId;
              if (typeof tid === "string") {
                threadIdRef.current = tid;
                setThreadId(tid);
              }
            } else if (
              event.type === "response.output_text.delta" &&
              typeof event.delta === "string"
            ) {
              contentRef.current += event.delta;
              setContent(contentRef.current);
            }
          },
          onError: (err) => {
            if (controller.signal.aborted) return;
            setError(err instanceof Error ? err.message : "Chat stream failed");
          },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Chat stream failed");
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsStreaming(false);
      }
    },
    [agent, endpoint],
  );

  // Abort any in-flight stream when the component unmounts.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  return {
    content,
    events,
    threadId,
    isStreaming,
    error,
    send,
    reset,
  };
}
