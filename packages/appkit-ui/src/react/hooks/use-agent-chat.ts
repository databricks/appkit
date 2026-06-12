import { useCallback, useEffect, useRef, useState } from "react";
import { connectSSE } from "@/js";

/**
 * Parse a wire string as JSON, returning the raw value (or `undefined`) when
 * it isn't valid JSON. Tool `arguments`/`output` arrive as serialized strings
 * on the Responses API; we surface the parsed value when possible so item
 * consumers don't each re-parse.
 */
function parseMaybeJson(value: string | undefined): unknown {
  if (value === undefined || value === "") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Find the last element matching `pred` (no `Array.prototype.findLast` dep). */
function findLast<T, S extends T>(
  arr: T[],
  pred: (value: T) => value is S,
): S | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i] as S;
  }
  return undefined;
}

/**
 * Text of the last `message` item — the terminal answer of the turn. Streams
 * live as that message's deltas arrive; earlier (superseded draft) messages
 * are ignored.
 */
function lastMessageText(list: AgentTurnItem[]): string {
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    if (it.kind === "message") return it.text;
  }
  return "";
}

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

/**
 * One ordered item in an agent turn, derived from the Responses-API output
 * items the agents plugin streams. Each ReAct round's assistant text is a
 * distinct `message` item; tool calls and their results sit between rounds.
 *
 * The list is ordered by the wire `output_index`, so the LAST `message` item
 * is the terminal answer and everything before it is intermediate "thinking"
 * (draft messages the model emitted alongside its tool calls, plus the tool
 * calls/results themselves).
 *
 * @see {@link UseAgentChatResult.items}
 */
export type AgentTurnItem =
  | {
      kind: "message";
      id: string;
      text: string;
      status: "in_progress" | "completed";
    }
  | {
      kind: "tool_call";
      id: string;
      callId: string;
      name: string;
      args: unknown;
      status: "in_progress" | "completed";
    }
  | {
      kind: "tool_result";
      id: string;
      callId: string;
      output: unknown;
      error?: string;
    };

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
  /**
   * Text of the FINAL assistant message item — the terminal answer of the
   * turn, updated live as its deltas stream in. With OpenAI-compatible Claude
   * the model emits a full draft answer alongside its tool calls on every
   * ReAct round; `content` surfaces only the last round's message, so it never
   * shows those duplicated drafts. For the full per-round structure (drafts,
   * tool calls, tool results) read {@link items} instead.
   */
  content: string;
  /**
   * Ordered list of turn items derived from the Responses-API output items,
   * keyed by wire `output_index`. Render everything before the last `message`
   * item as collapsible intermediate steps ("thinking" + tool calls/results)
   * and the last `message` item as the prominent answer. Messages stream in
   * live; tool calls flip to `completed` on their `done` event. Reset at the
   * start of each {@link send} and by {@link reset}.
   */
  items: AgentTurnItem[];
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
 * appends to it from the structured {@link UseAgentChatResult.items} list
 * (drafts, tool calls, tool results, and the terminal answer) or, for the
 * common case, just reads {@link UseAgentChatResult.content} (the final
 * answer text, streamed live and de-duplicated across ReAct rounds).
 *
 * @example
 * ```tsx
 * function Chat({ agent }: { agent: string }) {
 *   const { content, items, threadId, isStreaming, send, reset } = useAgentChat({ agent });
 *   const steps = items.slice(0, -1); // everything before the terminal answer
 *   return (
 *     <>
 *       {steps.length > 0 && (
 *         <details>
 *           <summary>Steps</summary>
 *           {steps.map((it) =>
 *             it.kind === "message" ? <p key={it.id}>{it.text}</p> :
 *             it.kind === "tool_call" ? <code key={it.id}>{it.name}</code> :
 *             <code key={it.id}>{String(it.output)}</code>,
 *           )}
 *         </details>
 *       )}
 *       <div>{content}</div>
 *     </>
 *   );
 * }
 * ```
 *
 * `content` is the terminal answer (streams live, de-duplicated across rounds).
 */
export function useAgentChat({
  agent,
  endpoint = "/api/agents/chat",
  onEvent,
}: UseAgentChatOptions): UseAgentChatResult {
  const [content, setContent] = useState("");
  const [items, setItems] = useState<AgentTurnItem[]>([]);
  const [events, setEvents] = useState<AgentChatEvent[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs avoid the standard "stale closure" problem with `send` and
  // `onEvent`: `send` is a stable callback that reads the latest
  // threadId/onEvent without re-mounting connectSSE on every render.
  const threadIdRef = useRef<string | null>(null);
  // Working copy of the ordered turn items, keyed by wire `item_id`. Mutated
  // as events arrive, then mirrored into `items`/`content` state.
  const itemsRef = useRef<AgentTurnItem[]>([]);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const abortControllerRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    threadIdRef.current = null;
    itemsRef.current = [];
    setContent("");
    setItems([]);
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

      itemsRef.current = [];
      setContent("");
      setItems([]);
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
              return;
            }

            // Reduce the Responses-API wire events into the ordered item list.
            // The translator emits items in `output_index` order, so simply
            // appending on `added` keeps the list ordered.
            const list = itemsRef.current;
            let changed = false;

            if (event.type === "response.output_item.added") {
              const it = event.item;
              if (it?.type === "message" && it.id) {
                list.push({
                  kind: "message",
                  id: it.id,
                  text: "",
                  status: "in_progress",
                });
                changed = true;
              } else if (it?.type === "function_call") {
                list.push({
                  kind: "tool_call",
                  id: it.id ?? it.call_id ?? `fc_${list.length}`,
                  callId: it.call_id ?? "",
                  name: it.name ?? "",
                  args: parseMaybeJson(it.arguments),
                  status: "in_progress",
                });
                changed = true;
              } else if (it?.type === "function_call_output") {
                list.push({
                  kind: "tool_result",
                  id: it.id ?? `fc_output_${list.length}`,
                  callId: it.call_id ?? "",
                  output: parseMaybeJson(it.output),
                });
                changed = true;
              }
            } else if (event.type === "response.output_item.done") {
              const it = event.item;
              if (it?.type === "function_call") {
                const callId = it.call_id ?? "";
                const target = findLast(
                  list,
                  (x): x is Extract<AgentTurnItem, { kind: "tool_call" }> =>
                    x.kind === "tool_call" &&
                    (x.callId === callId || x.id === it.id),
                );
                if (target) {
                  target.status = "completed";
                  if (it.arguments !== undefined) {
                    target.args = parseMaybeJson(it.arguments);
                  }
                  if (it.name) target.name = it.name;
                  changed = true;
                }
              } else if (it?.type === "message" && it.id) {
                const target = findLast(
                  list,
                  (x): x is Extract<AgentTurnItem, { kind: "message" }> =>
                    x.kind === "message" && x.id === it.id,
                );
                if (target) {
                  target.status = "completed";
                  changed = true;
                }
              }
            } else if (
              event.type === "response.output_text.delta" &&
              typeof event.delta === "string"
            ) {
              const target = findLast(
                list,
                (x): x is Extract<AgentTurnItem, { kind: "message" }> =>
                  x.kind === "message" && x.id === event.item_id,
              );
              if (target) {
                target.text += event.delta;
                changed = true;
              }
            }

            if (changed) {
              // Clone so React sees a new reference; item objects are mutated
              // in place in the ref, so shallow-copy them too.
              const snapshot = list.map((x) => ({ ...x }));
              setItems(snapshot);
              setContent(lastMessageText(snapshot));
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
    items,
    events,
    threadId,
    isStreaming,
    error,
    send,
    reset,
  };
}
