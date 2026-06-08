import { type AgentChatEvent, useAgentChat } from "@databricks/appkit-ui/react";
import { useCallback, useMemo, useRef } from "react";
import { beginStreamRun, recordStreamEvent } from "./use-stream-inspector";

/**
 * Backwards-compatible alias for the SSE event shape that the rest of
 * the smart-dashboard code (stream inspector, chat section, action
 * dispatcher) already knows about. Identical to {@link AgentChatEvent}
 * from `@databricks/appkit-ui/react` — keeping the name in this module
 * means downstream callers don't need to be touched.
 */
export type SSEEvent = AgentChatEvent;

interface UseAgentStreamOptions {
  agentName: string;
  onEvent?: (event: SSEEvent) => void;
}

interface SendOptions {
  /**
   * Text prepended to the user's message on the wire. Used by the Smart
   * Dashboard route to inject active filters / highlights into the system
   * prompt so the agent always knows what the user is looking at.
   */
  contextPrefix?: string;
}

interface UseAgentStreamReturn {
  content: string;
  events: SSEEvent[];
  isLoading: boolean;
  threadId: string | null;
  send: (message: string, opts?: SendOptions) => Promise<void>;
  reset: () => void;
}

/**
 * Smart-Dashboard wrapper around `useAgentChat` from
 * `@databricks/appkit-ui/react`. The shared hook owns the fetch + SSE
 * parsing + state plumbing; this wrapper adds two playground-specific
 * concerns:
 *
 *   1. **`contextPrefix`** on `send()` — the dashboard injects active
 *      filters / highlights into the user message so the agent always
 *      sees the UI state. The shared hook stays narrow and lets us
 *      compose the message here.
 *   2. **Stream inspector wiring** — every send opens a `StreamRecord`
 *      via {@link beginStreamRun} and forwards every event to
 *      {@link recordStreamEvent} so the inspector drawer can render a
 *      human-legible timeline. None of that belongs in the shared hook.
 *
 * Aside from those two layers this hook is a re-export: the SSE parsing
 * code that used to live here moved into `useAgentChat`, and the API
 * surface is preserved so existing callers (`smart-dashboard.route`,
 * `agent-sidebar`) keep working.
 */
export function useAgentStream({
  agentName,
  onEvent,
}: UseAgentStreamOptions): UseAgentStreamReturn {
  // `runId` is captured at `send()` time so every event of the same run
  // lands in the same StreamRecord. Stored as a ref to avoid re-mounting
  // the chat hook every time the inspector dispatches.
  const runIdRef = useRef<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const handleEvent = useCallback((event: AgentChatEvent) => {
    if (runIdRef.current) {
      recordStreamEvent(runIdRef.current, event);
    }
    onEventRef.current?.(event);
  }, []);

  const {
    content: chatContent,
    events,
    isStreaming,
    threadId,
    error,
    send: chatSend,
    reset,
  } = useAgentChat({ agent: agentName, onEvent: handleEvent });

  const send = useCallback(
    async (message: string, opts?: SendOptions) => {
      runIdRef.current = beginStreamRun(
        `${agentName}: ${message.slice(0, 80)}`,
      );
      const wire = opts?.contextPrefix
        ? `${opts.contextPrefix}${message}`
        : message;
      try {
        await chatSend(wire);
      } finally {
        runIdRef.current = null;
      }
    },
    [agentName, chatSend],
  );

  // Surface fetch-level failures in the displayed content so the
  // dashboard's assistant message turns into a visible error row,
  // mirroring the prior hook's UX (it wrote "Error: ..." into the
  // streamed content on `!res.ok`). `useAgentChat` exposes the error
  // via a dedicated `error` field; we project it into `content` only
  // when the stream actually failed, otherwise pass `chat.content`
  // through verbatim.
  const content = useMemo(() => {
    if (error) return `Error: ${error}`;
    return chatContent;
  }, [error, chatContent]);

  return {
    content,
    events,
    // `isLoading` is the legacy name; the shared hook uses `isStreaming`.
    isLoading: isStreaming,
    threadId,
    send,
    reset,
  };
}
