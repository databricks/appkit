import { getPluginClientConfig } from "@databricks/appkit-ui/js";
import type { AgentTurnItem } from "@databricks/appkit-ui/react";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/agent")({
  component: AgentRoute,
});

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

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  /** User text, or — for assistant turns — the terminal answer text. */
  content: string;
  /**
   * For assistant turns: the ordered per-round trace (intermediate draft
   * messages, tool calls, tool results, and the final answer). Rendered as a
   * collapsible "Steps" section above the answer. Undefined for user turns.
   */
  items?: AgentTurnItem[];
}

/** Parse a wire JSON string, falling back to the raw value. */
function parseMaybeJson(value: string | undefined): unknown {
  if (value === undefined || value === "") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Text of the last `message` item — the terminal answer. */
function lastMessageText(items: AgentTurnItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "message") return it.text;
  }
  return "";
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === "") return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function summarizeOutput(output: unknown): string {
  const s = typeof output === "string" ? output : JSON.stringify(output);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Renders an assistant turn: collapsible intermediate steps (every item before
 * the last `message`) plus the terminal answer streamed live below.
 */
function AssistantTurn({ items }: { items: AgentTurnItem[] }) {
  const lastMessageIdx = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "message") return i;
    }
    return -1;
  })();
  const steps = lastMessageIdx >= 0 ? items.slice(0, lastMessageIdx) : items;
  const answer = lastMessageIdx >= 0 ? lastMessageText(items) : "";

  return (
    <div className="max-w-[85%] space-y-2">
      {steps.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Steps ({steps.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 space-y-1 border-l-2 border-muted pl-3">
            {steps.map((it) => {
              if (it.kind === "message") {
                return (
                  <p
                    key={it.id}
                    className="whitespace-pre-wrap text-xs text-muted-foreground/80"
                  >
                    {it.text}
                  </p>
                );
              }
              if (it.kind === "tool_call") {
                return (
                  <div
                    key={it.id}
                    className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-mono"
                  >
                    <span className="font-semibold">{it.name}</span>
                    <span className="opacity-60 truncate">
                      ({summarizeArgs(it.args)})
                    </span>
                  </div>
                );
              }
              return (
                <div
                  key={it.id}
                  className={`rounded px-2 py-0.5 text-xs font-mono ${
                    it.error
                      ? "bg-red-500/10 text-red-600"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {it.error ? `error: ${it.error}` : summarizeOutput(it.output)}
                </div>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="rounded-lg bg-muted px-4 py-2">
        <p className="whitespace-pre-wrap text-sm">{answer}</p>
      </div>
    </div>
  );
}

interface PendingApproval {
  approvalId: string;
  streamId: string;
  toolName: string;
  args: unknown;
}

function useAutocomplete(enabled: boolean) {
  const [suggestion, setSuggestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestSuggestion = useCallback(
    (text: string) => {
      setSuggestion("");

      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();

      if (!text.trim() || text.length < 3 || !enabled) {
        return;
      }

      timerRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setIsLoading(true);

        try {
          const response = await fetch("/api/agents/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, agent: "autocomplete" }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) return;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let result = "";
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
                const event = JSON.parse(data);
                if (
                  event.type === "response.output_text.delta" &&
                  event.delta
                ) {
                  result += event.delta;
                  setSuggestion(result);
                }
              } catch {
                /* skip */
              }
            }
          }
        } catch {
          /* aborted or failed */
        } finally {
          setIsLoading(false);
        }
      }, 500);
    },
    [enabled],
  );

  const clear = useCallback(() => {
    setSuggestion("");
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();
  }, []);

  return {
    suggestion,
    isLoading: isLoading && !suggestion,
    requestSuggestion,
    clear,
  };
}

function AgentRoute() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "deny") => {
      const approval = pendingApprovals.find(
        (a) => a.approvalId === approvalId,
      );
      if (!approval) return;
      try {
        await fetch("/api/agents/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            streamId: approval.streamId,
            approvalId,
            decision,
          }),
        });
      } finally {
        setPendingApprovals((prev) =>
          prev.filter((a) => a.approvalId !== approvalId),
        );
      }
    },
    [pendingApprovals],
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const msgIdCounter = useRef(0);

  const agentConfig = getPluginClientConfig<{
    agents?: string[];
    defaultAgent?: string;
  }>("agents");
  const hasAutocomplete = (agentConfig.agents ?? []).includes("autocomplete");

  const {
    suggestion,
    isLoading: isAutocompleting,
    requestSuggestion,
    clear: clearSuggestion,
  } = useAutocomplete(hasAutocomplete);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    clearSuggestion();
    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: ++msgIdCounter.current, role: "user", content: userMessage },
    ]);
    setEvents([]);
    setIsLoading(true);

    try {
      const response = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          ...(threadId && { threadId }),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        setMessages((prev) => [
          ...prev,
          {
            id: ++msgIdCounter.current,
            role: "assistant",
            content: `Error: ${error.error}`,
          },
        ]);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      // Per-round trace items for this assistant turn, keyed by wire item id.
      const turnItems: AgentTurnItem[] = [];
      const assistantId = ++msgIdCounter.current;
      let buffer = "";

      const flushAssistant = () => {
        const snapshot = turnItems.map((x) => ({ ...x }));
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          const next: ChatMessage = {
            id: assistantId,
            role: "assistant",
            content: lastMessageText(snapshot),
            items: snapshot,
          };
          if (last?.role === "assistant" && last.id === assistantId) {
            updated[updated.length - 1] = next;
          } else {
            updated.push(next);
          }
          return updated;
        });
      };

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

            if (
              event.type === "appkit.approval_pending" &&
              event.approval_id &&
              event.stream_id &&
              event.tool_name
            ) {
              setPendingApprovals((prev) => [
                ...prev,
                {
                  approvalId: event.approval_id as string,
                  streamId: event.stream_id as string,
                  toolName: event.tool_name as string,
                  args: event.args,
                },
              ]);
            }
            if (event.type === "appkit.metadata" && event.data?.threadId) {
              setThreadId(event.data.threadId as string);
            }

            // Build the ordered per-round item list. The translator emits
            // items in output_index order, so appending on `added` keeps it
            // ordered. Each ReAct round's draft is its own message item, so the
            // duplicated drafts surface as collapsible steps, not the answer.
            let changed = false;
            const it = event.item;
            if (event.type === "response.output_item.added") {
              if (it?.type === "message" && it.id) {
                turnItems.push({
                  kind: "message",
                  id: it.id,
                  text: "",
                  status: "in_progress",
                });
                changed = true;
              } else if (it?.type === "function_call") {
                turnItems.push({
                  kind: "tool_call",
                  id: it.id ?? it.call_id ?? `fc_${turnItems.length}`,
                  callId: it.call_id ?? "",
                  name: it.name ?? "",
                  args: parseMaybeJson(it.arguments),
                  status: "in_progress",
                });
                changed = true;
              } else if (it?.type === "function_call_output") {
                turnItems.push({
                  kind: "tool_result",
                  id: it.id ?? `fc_output_${turnItems.length}`,
                  callId: it.call_id ?? "",
                  output: parseMaybeJson(it.output),
                });
                changed = true;
              }
            } else if (event.type === "response.output_item.done") {
              if (it?.type === "function_call") {
                for (let i = turnItems.length - 1; i >= 0; i--) {
                  const t = turnItems[i];
                  if (
                    t.kind === "tool_call" &&
                    (t.callId === it.call_id || t.id === it.id)
                  ) {
                    t.status = "completed";
                    if (it.arguments !== undefined) {
                      t.args = parseMaybeJson(it.arguments);
                    }
                    changed = true;
                    break;
                  }
                }
              } else if (it?.type === "message" && it.id) {
                for (let i = turnItems.length - 1; i >= 0; i--) {
                  const t = turnItems[i];
                  if (t.kind === "message" && t.id === it.id) {
                    t.status = "completed";
                    changed = true;
                    break;
                  }
                }
              }
            } else if (
              event.type === "response.output_text.delta" &&
              event.delta
            ) {
              for (let i = turnItems.length - 1; i >= 0; i--) {
                const t = turnItems[i];
                if (t.kind === "message" && t.id === event.item_id) {
                  t.text += event.delta;
                  changed = true;
                  break;
                }
              }
            }

            if (changed) flushAssistant();
          } catch {
            // skip malformed events
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: ++msgIdCounter.current,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, threadId, clearSuggestion]);

  const handleInputChange = (value: string) => {
    setInput(value);
    requestSuggestion(value);
  };

  const acceptSuggestion = () => {
    if (!suggestion) return;
    const newValue = input + suggestion;
    setInput(newValue);
    clearSuggestion();
    inputRef.current?.focus();
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Agent Chat</h1>
            <p className="text-base text-muted-foreground">
              AI agent with auto-discovered tools from all AppKit plugins.
              {threadId && (
                <span className="ml-2 text-xs font-mono opacity-60">
                  Thread: {threadId.slice(0, 8)}...
                </span>
              )}
            </p>
          </div>
          {hasAutocomplete && (
            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
              Autocomplete enabled
            </span>
          )}
        </div>

        <div className="flex gap-6 h-[700px]">
          <div className="flex-1 flex flex-col border rounded-lg bg-card min-w-0">
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-muted-foreground py-20">
                  <p className="text-lg">
                    Send a message to start a conversation
                  </p>
                  <p className="text-sm mt-2">
                    The agent can use analytics, files, genie, and lakebase
                    tools.
                    {hasAutocomplete && " Start typing for inline suggestions."}
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {msg.role === "assistant" && msg.items ? (
                    <AssistantTurn items={msg.items} />
                  ) : (
                    <div
                      className={`max-w-[85%] rounded-lg px-4 py-2 ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      }`}
                    >
                      <p className="whitespace-pre-wrap text-sm">
                        {msg.content}
                      </p>
                    </div>
                  )}
                </div>
              ))}

              {pendingApprovals.map((approval) => (
                <div key={approval.approvalId} className="flex justify-start">
                  <div className="max-w-[80%] rounded-lg border border-orange-500/60 bg-orange-500/10 px-4 py-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="rounded bg-orange-600 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
                        Destructive tool — approval required
                      </span>
                    </div>
                    <div className="text-sm">
                      <strong>{approval.toolName}</strong>
                      <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
                        {JSON.stringify(approval.args, null, 2)}
                      </pre>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          decideApproval(approval.approvalId, "deny")
                        }
                      >
                        Deny
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          decideApproval(approval.approvalId, "approve")
                        }
                      >
                        Approve
                      </Button>
                    </div>
                  </div>
                </div>
              ))}

              {isLoading &&
                pendingApprovals.length === 0 &&
                messages[messages.length - 1]?.role === "user" && (
                  <div className="flex justify-start">
                    <div className="bg-muted rounded-lg px-4 py-2">
                      <p className="text-sm text-muted-foreground animate-pulse">
                        Thinking...
                      </p>
                    </div>
                  </div>
                )}

              <div ref={messagesEndRef} />
            </div>

            <div className="border-t p-4">
              {hasAutocomplete && (suggestion || isAutocompleting) && (
                <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                  {isAutocompleting && (
                    <span className="animate-pulse">Thinking...</span>
                  )}
                  {suggestion && (
                    <span>
                      Press{" "}
                      <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[10px] font-mono">
                        Tab
                      </kbd>{" "}
                      to accept suggestion
                    </span>
                  )}
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendMessage();
                }}
                className="flex gap-2"
              >
                <div className="flex-1 relative">
                  <div
                    aria-hidden
                    className="absolute inset-0 px-3 py-2 text-sm pointer-events-none whitespace-pre-wrap break-words overflow-hidden"
                  >
                    <span className="invisible">{input}</span>
                    <span className="text-muted-foreground/40">
                      {suggestion}
                    </span>
                  </div>
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => handleInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Tab" && suggestion) {
                        e.preventDefault();
                        acceptSuggestion();
                      }
                      if (e.key === "Escape" && suggestion) {
                        clearSuggestion();
                      }
                      if (e.key === "Enter" && !e.shiftKey && !suggestion) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Ask a question..."
                    disabled={isLoading}
                    rows={1}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 resize-none"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isLoading || !input.trim()}
                  className="self-end"
                >
                  Send
                </Button>
              </form>
            </div>
          </div>

          <div className="w-80 shrink-0 flex flex-col border rounded-lg bg-card">
            <div className="px-3 py-2 border-b">
              <h3 className="text-sm font-semibold text-muted-foreground">
                Event Stream
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {events.length === 0 && (
                <p className="text-xs text-muted-foreground/50 text-center py-8">
                  Events will appear here
                </p>
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
                  <div
                    key={`${event.type}-${i}`}
                    className="font-mono text-xs text-muted-foreground"
                  >
                    <span className="inline-block w-24 text-right mr-2 opacity-50">
                      {event.type
                        .replace("response.", "")
                        .replace("appkit.", "")}
                    </span>
                    <span className="opacity-80 break-all">{detail}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
