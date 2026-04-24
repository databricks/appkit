import { useCallback, useRef, useState } from "react";

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
}

interface UseAgentStreamOptions {
  agentName: string;
  onEvent?: (event: SSEEvent) => void;
}

interface UseAgentStreamReturn {
  content: string;
  events: SSEEvent[];
  isLoading: boolean;
  threadId: string | null;
  send: (message: string) => Promise<void>;
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
    async (message: string) => {
      setIsLoading(true);
      setContent("");
      setEvents([]);
      contentRef.current = "";

      try {
        const res = await fetch("/api/agents/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
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
