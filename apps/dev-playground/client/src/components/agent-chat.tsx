import { Button } from "@databricks/appkit-ui/react";
import {
  useAgentToolCatalog,
  useDispatchClientTool,
} from "@databricks/appkit-ui/react/beta";
import { useCallback, useRef, useState } from "react";

/**
 * Reusable agent chat panel for the "UI as a tool" demos. Snapshots the live
 * tool catalog from the surrounding `<AgentToolsProvider>` (synthesized verb
 * tools + `ui_snapshot`, plus any `useAgentTool` tools), sends it as `uiTools`
 * on each `POST /chat`, and round-trips every `appkit.client_tool_call` event
 * through `useDispatchClientTool`.
 *
 * Must be rendered inside an `<AgentToolsProvider>`.
 */
export function AgentChat({ placeholder }: { placeholder?: string }) {
  const catalog = useAgentToolCatalog();
  const dispatchClientTool = useDispatchClientTool();

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<EventLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);

  const idRef = useRef(0);
  const nextId = useCallback(() => ++idRef.current, []);

  const appendEvent = useCallback(
    (label: string, detail: string) => {
      setEvents((prev) => [...prev, { id: nextId(), label, detail }]);
    },
    [nextId],
  );

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: trimmed },
    ]);
    setIsLoading(true);

    try {
      const res = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          ...(threadId && { threadId }),
          uiTools: catalog,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content: `Server error (${res.status}): ${text}`,
          },
        ]);
        return;
      }

      await consumeStream(res, {
        dispatchClientTool,
        appendEvent,
        setMessages,
        setThreadId,
        nextId,
      });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [
    input,
    isLoading,
    threadId,
    catalog,
    dispatchClientTool,
    appendEvent,
    nextId,
  ]);

  return (
    <div className="flex-1 flex gap-4 h-[600px] min-w-0">
      <div className="flex-1 flex flex-col border rounded-lg bg-card min-w-0">
        <div className="border-b px-4 py-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">Chat</h3>
          <span className="text-xs text-muted-foreground">
            {catalog.length} tool(s) available
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-16">
              <p className="text-sm">
                Send a message — the agent can see and drive the UI on the left.
              </p>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground animate-pulse">
                Thinking…
              </div>
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="border-t p-3 flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder ?? "Tell the agent what to do…"}
            disabled={isLoading}
            className="flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            Send
          </Button>
        </form>
      </div>
      <div className="w-72 shrink-0 flex flex-col border rounded-lg bg-card">
        <div className="px-3 py-2 border-b">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Round-trip events
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1 font-mono text-xs">
          {events.length === 0 && (
            <p className="text-muted-foreground/50 text-center py-4">
              Tool round-trips will appear here.
            </p>
          )}
          {events.map((evt) => (
            <div key={evt.id} className="text-muted-foreground">
              <span className="opacity-50 inline-block w-24 text-right mr-2">
                {evt.label}
              </span>
              <span className="opacity-90 break-all">{evt.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

interface EventLine {
  id: number;
  label: string;
  detail: string;
}

interface ClientToolCallEvent {
  type: "appkit.client_tool_call";
  call_id: string;
  stream_id: string;
  tool_name: string;
  args: unknown;
}

interface ConsumeStreamArgs {
  dispatchClientTool: ReturnType<typeof useDispatchClientTool>;
  appendEvent: (label: string, detail: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setThreadId: React.Dispatch<React.SetStateAction<string | null>>;
  nextId: () => number;
}

/**
 * Consume the SSE chat stream, accumulate assistant text, and round-trip any
 * `appkit.client_tool_call` events through the registry. The `streamId` POSTed
 * to `/client-tool-result` comes from the event itself; the server keys
 * pending gates by stream and rejects mismatches.
 */
async function consumeStream(
  response: Response,
  args: ConsumeStreamArgs,
): Promise<void> {
  const { dispatchClientTool, appendEvent, setMessages, setThreadId, nextId } =
    args;

  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();

  let buffer = "";
  let assistantContent = "";

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
      let evt: { type?: string; [k: string]: unknown };
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (!evt.type) continue;

      if (evt.type === "appkit.metadata") {
        const tid = (evt.data as { threadId?: unknown } | undefined)?.threadId;
        if (typeof tid === "string") setThreadId(tid);
        continue;
      }

      if (evt.type === "response.output_text.delta") {
        const delta = (evt as { delta?: unknown }).delta;
        if (typeof delta !== "string") continue;
        assistantContent += delta;
        const snapshot = assistantContent;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = { ...last, content: snapshot };
          } else {
            updated.push({
              id: nextId(),
              role: "assistant",
              content: snapshot,
            });
          }
          return updated;
        });
        continue;
      }

      if (evt.type === "response.output_item.done") {
        const item = (evt as { item?: { type?: string; name?: string } }).item;
        if (item?.type === "function_call") {
          appendEvent("tool_call", item.name ?? "<unnamed>");
        }
        continue;
      }

      if (evt.type === "appkit.client_tool_call") {
        const call = evt as unknown as ClientToolCallEvent;
        appendEvent(
          "client_tool_call",
          `${call.tool_name}(${JSON.stringify(call.args ?? {})})`,
        );
        const outcome = await dispatchClientTool(
          call.tool_name,
          (call.args ?? {}) as Record<string, unknown>,
        );
        appendEvent(
          outcome.kind === "ok" ? "tool_result" : "tool_error",
          outcome.kind === "ok"
            ? JSON.stringify(outcome.result)
            : outcome.error,
        );
        const body =
          outcome.kind === "ok"
            ? {
                streamId: call.stream_id,
                callId: call.call_id,
                result: outcome.result,
              }
            : {
                streamId: call.stream_id,
                callId: call.call_id,
                error: outcome.error,
              };
        try {
          await fetch("/api/agents/client-tool-result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (err) {
          appendEvent(
            "post_failed",
            err instanceof Error ? err.message : "Unknown error",
          );
        }
        continue;
      }

      if (evt.type === "error") {
        appendEvent(
          "error",
          (evt as { error?: string }).error ?? "Unknown error",
        );
      }
    }
  }
}
