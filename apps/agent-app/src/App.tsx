import { TooltipProvider } from "@databricks/appkit-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { ThemeSelector } from "./components/theme-selector";

interface SSEEvent {
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

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  const [toolCount, setToolCount] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetch("/api/agent/info")
        .then((r) => r.json())
        .then((data) => setToolCount(data.toolCount ?? 0))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const text = input.trim();
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: ++idRef.current, role: "user", content: text },
    ]);
    setEvents([]);
    setIsLoading(true);

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(threadId && { threadId }),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMessages((prev) => [
          ...prev,
          {
            id: ++idRef.current,
            role: "assistant",
            content: `Error: ${err.error}`,
          },
        ]);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let content = "";
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

            if (event.type === "appkit.metadata" && event.data?.threadId) {
              setThreadId(event.data.threadId as string);
            }
            if (event.type === "response.output_text.delta" && event.delta) {
              content += event.delta;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = { ...last, content };
                } else {
                  updated.push({
                    id: ++idRef.current,
                    role: "assistant",
                    content,
                  });
                }
                return updated;
              });
            }
          } catch {
            /* skip */
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: ++idRef.current,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, threadId]);

  return (
    <TooltipProvider>
      <div className="app">
        <div className="container">
          <header className="header">
            <div>
              <h1>Agent Chat</h1>
              <p className="subtitle">
                AI agent with {toolCount} auto-discovered tools
                {threadId && (
                  <span className="thread-id">
                    {" "}
                    · Thread {threadId.slice(0, 8)}
                  </span>
                )}
              </p>
            </div>
            <ThemeSelector />
          </header>

          <div className="main-layout">
            <div className="chat-panel">
              <div className="messages">
                {messages.length === 0 && (
                  <div className="empty-state">
                    <p className="empty-title">
                      Send a message to start a conversation
                    </p>
                    <p className="empty-sub">
                      The agent can query data, browse files, and more
                    </p>
                  </div>
                )}

                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`message-row ${msg.role === "user" ? "user" : "assistant"}`}
                  >
                    <div className={`bubble ${msg.role}`}>
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                ))}

                {isLoading &&
                  messages[messages.length - 1]?.role === "user" && (
                    <div className="message-row assistant">
                      <div className="bubble assistant thinking">
                        Thinking...
                      </div>
                    </div>
                  )}

                <div ref={messagesEndRef} />
              </div>

              <form
                className="input-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendMessage();
                }}
              >
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="Ask a question..."
                  disabled={isLoading}
                  rows={1}
                />
                <button type="submit" disabled={isLoading || !input.trim()}>
                  Send
                </button>
              </form>
            </div>

            <div className="event-panel">
              <div className="event-header">Event Stream</div>
              <div className="event-list">
                {events.length === 0 && (
                  <p className="event-empty">Events will appear here</p>
                )}
                {events.map((event, i) => {
                  let detail: string;
                  switch (event.type) {
                    case "response.output_text.delta":
                      detail = event.delta?.slice(0, 60) ?? "";
                      break;
                    case "response.output_item.added":
                    case "response.output_item.done":
                      detail =
                        event.item?.type === "function_call"
                          ? `${event.item.name}(${(event.item.arguments ?? "").slice(0, 40)})`
                          : event.item?.type === "function_call_output"
                            ? (event.item.output?.slice(0, 60) ?? "")
                            : (event.item?.status ?? event.item?.type ?? "");
                      break;
                    case "response.completed":
                      detail = "done";
                      break;
                    case "error":
                      detail = event.error ?? "unknown";
                      break;
                    case "appkit.metadata":
                      detail = JSON.stringify(event.data).slice(0, 60);
                      break;
                    case "appkit.thinking":
                      detail = event.content?.slice(0, 60) ?? "";
                      break;
                    default:
                      detail = JSON.stringify(event).slice(0, 60);
                  }
                  return (
                    <div key={`${event.type}-${i}`} className="event-row">
                      <span className="event-type">
                        {event.type
                          .replace("response.", "")
                          .replace("appkit.", "")}
                      </span>
                      <span className="event-detail">{detail}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
