import { useCallback, useRef, useState } from "react";
import { beginStreamRun, recordStreamEvent } from "./use-stream-inspector";

export interface SSEEvent {
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
  // appkit.approval_pending payload
  approval_id?: string;
  stream_id?: string;
  tool_name?: string;
  args?: unknown;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  };
}

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

export function useAgentStream({
  agentName,
  onEvent,
}: UseAgentStreamOptions): UseAgentStreamReturn {
  const [content, setContent] = useState("");
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const contentRef = useRef("");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const reset = useCallback(() => {
    setContent("");
    setEvents([]);
    contentRef.current = "";
  }, []);

  const send = useCallback(
    async (message: string, opts?: SendOptions) => {
      setIsLoading(true);
      setContent("");
      setEvents([]);
      contentRef.current = "";

      const wire = opts?.contextPrefix
        ? `${opts.contextPrefix}${message}`
        : message;

      const runId = beginStreamRun(`${agentName}: ${message.slice(0, 80)}`);

      try {
        const res = await fetch("/api/agents/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: wire,
            agent: agentName,
            ...(threadId && { threadId }),
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          try {
            const err = JSON.parse(errText);
            setContent(`Error: ${err.error}`);
          } catch {
            setContent(`Error: Server returned ${res.status}`);
          }
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const event: SSEEvent = JSON.parse(data);
              if (!event.type) continue;
              setEvents((prev) => [...prev, event]);
              recordStreamEvent(runId, event);
              onEventRef.current?.(event);

              if (event.type === "appkit.metadata" && event.data?.threadId) {
                setThreadId(event.data.threadId as string);
              }
              if (event.type === "response.output_text.delta" && event.delta) {
                contentRef.current += event.delta;
                setContent(contentRef.current);
              }
            } catch {
              /* skip malformed events */
            }
          }
        }
      } catch (err) {
        setContent(
          `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      } finally {
        setIsLoading(false);
      }
    },
    [agentName, threadId],
  );

  return { content, events, isLoading, threadId, send, reset };
}
