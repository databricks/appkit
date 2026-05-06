import { useChat } from "@ai-sdk/react";
import { getPluginClientConfig } from "@databricks/appkit-ui/js";
import { Button } from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  VERCEL_AI_UI_MESSAGE_STREAM_ACCEPT,
  type VercelAIAgentDataParts,
  type VercelAIAgentUIMessage,
} from "../lib/vercel-ai-agent-chat";

export const Route = createFileRoute("/agent")({
  component: AgentRoute,
});

type ApprovalPendingPayload = VercelAIAgentDataParts["approval-pending"];

type PendingApproval = ApprovalPendingPayload;

/**
 * Inline-suggestion autocomplete still uses the legacy Responses-API SSE
 * shape on `/api/agents/chat`. The autocomplete agent runs as a one-shot
 * stateless completion (its `agent.md` flags `ephemeral: true`), so it
 * doesn't share the chat thread with the conversational `useChat` flow
 * and there's nothing to gain from migrating it here.
 */
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

/**
 * Concatenate all `text` parts of a message — `useChat` keeps text
 * streamed across multiple `text-delta` chunks as a single `TextUIPart`,
 * but if the agent loop reopens text after a tool call, the message
 * carries multiple text parts. For chat-bubble rendering we want them
 * joined.
 */
function messageBodyText(message: VercelAIAgentUIMessage): string {
  let body = "";
  for (const part of message.parts) {
    if (part.type === "text") body += part.text;
  }
  return body;
}

function AgentRoute() {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");

  const agentConfig = getPluginClientConfig<{
    agents?: string[];
    defaultAgent?: string;
  }>("agents");
  const hasAutocomplete = (agentConfig.agents ?? []).includes("autocomplete");

  const transport = useMemo(
    () =>
      new DefaultChatTransport<VercelAIAgentUIMessage>({
        api: "/api/agents/chat",
        headers: {
          Accept: VERCEL_AI_UI_MESSAGE_STREAM_ACCEPT,
        },
      }),
    [],
  );

  // We deliberately do NOT pass `id` to useChat. The hook auto-mints one
  // through the AI SDK's own `generateId` (which doesn't depend on the
  // browser's `crypto.randomUUID`, so it survives environments where the
  // global is shimmed or stripped) and exposes it on the return value.
  // The chat id is sent to the server as the request body `id` and the
  // agents plugin maps it 1:1 to its `threadId`.
  const {
    id: chatId,
    messages,
    sendMessage,
    status,
    error,
    stop,
  } = useChat<VercelAIAgentUIMessage>({
    transport,
    onData: (part) => {
      if (part.type === "data-approval-pending") {
        const payload = part.data as ApprovalPendingPayload;
        setPendingApprovals((prev) =>
          prev.some((p) => p.approvalId === payload.approvalId)
            ? prev
            : [...prev, payload],
        );
      }
    },
  });

  const isLoading = status === "submitted" || status === "streaming";

  // `useChat` creates the assistant `UIMessage` stub the moment the server
  // emits its `start` chunk — well before any text-delta arrives. We want
  // to show "Thinking..." until the assistant has produced visible text
  // (either rendered tokens or a fully-materialised message). Tool-only
  // turns therefore keep the indicator up until the model speaks.
  const lastMessage = messages[messages.length - 1];
  const lastAssistantHasText =
    lastMessage?.role === "assistant" &&
    messageBodyText(lastMessage).length > 0;
  const showThinking =
    isLoading && pendingApprovals.length === 0 && !lastAssistantHasText;

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

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || isLoading) return;
    clearSuggestion();
    setInput("");
    sendMessage({ text });
  }, [input, isLoading, clearSuggestion, sendMessage]);

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
              <span className="ml-2 text-xs font-mono opacity-60">
                Chat: {chatId.slice(0, 8)}...
              </span>
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

              {messages.map((msg) => {
                const body = messageBodyText(msg);
                if (!body) return null;
                return (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-lg px-4 py-2 ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      }`}
                    >
                      <p className="whitespace-pre-wrap text-sm">{body}</p>
                    </div>
                  </div>
                );
              })}

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

              {showThinking && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg px-4 py-2">
                    <p className="text-sm text-muted-foreground animate-pulse">
                      Thinking...
                    </p>
                  </div>
                </div>
              )}

              {error && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg border border-red-500/60 bg-red-500/10 px-4 py-2">
                    <p className="text-sm">Error: {error.message}</p>
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
                  submit();
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
                        submit();
                      }
                    }}
                    placeholder="Ask a question..."
                    disabled={isLoading}
                    rows={1}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 resize-none"
                  />
                </div>
                {isLoading ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={stop}
                    className="self-end"
                  >
                    Stop
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={!input.trim()}
                    className="self-end"
                  >
                    Send
                  </Button>
                )}
              </form>
            </div>
          </div>

          <EventStreamPanel messages={messages} approvals={pendingApprovals} />
        </div>
      </div>
    </div>
  );
}

interface EventStreamRow {
  /** Stable React key. */
  key: string;
  /** Short label rendered in the left column. */
  label: string;
  /** Free-form right-column detail. */
  detail: string;
}

/**
 * Right-hand debug panel. Walks every part of every message and renders a
 * compact, terse log entry per part. Pairs with `pendingApprovals` so the
 * panel surfaces approval prompts (which arrive via `onData`, not as
 * message parts) alongside the message-derived rows.
 */
function EventStreamPanel({
  messages,
  approvals,
}: {
  messages: VercelAIAgentUIMessage[];
  approvals: PendingApproval[];
}) {
  const rows: EventStreamRow[] = [];

  for (const message of messages) {
    let partIndex = 0;
    for (const part of message.parts) {
      const key = `${message.id}:${partIndex++}`;
      if (part.type === "text") {
        rows.push({
          key,
          label: message.role === "user" ? "user" : "text",
          detail: part.text.slice(0, 80),
        });
      } else if (part.type === "reasoning") {
        rows.push({
          key,
          label: "reasoning",
          detail: part.text.slice(0, 80),
        });
      } else if (part.type === "dynamic-tool") {
        const detail =
          part.state === "output-available"
            ? safeStringify(part.output).slice(0, 80)
            : part.state === "output-error"
              ? `error: ${part.errorText}`
              : safeStringify(part.input).slice(0, 80);
        rows.push({
          key,
          label: `tool:${part.toolName}`,
          detail: `${part.state} ${detail}`,
        });
      } else if (part.type === "step-start") {
        rows.push({ key, label: "step", detail: "start" });
      } else if (
        typeof part.type === "string" &&
        part.type.startsWith("data-")
      ) {
        const data = (part as { data?: unknown }).data;
        rows.push({
          key,
          label: part.type.replace(/^data-/, "data:"),
          detail: safeStringify(data).slice(0, 80),
        });
      }
    }
  }

  for (const approval of approvals) {
    rows.push({
      key: `pending:${approval.approvalId}`,
      label: "approval",
      detail: `pending: ${approval.toolName}`,
    });
  }

  return (
    <div className="w-80 shrink-0 flex flex-col border rounded-lg bg-card">
      <div className="px-3 py-2 border-b">
        <h3 className="text-sm font-semibold text-muted-foreground">
          Event Stream
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground/50 text-center py-8">
            Events will appear here
          </p>
        )}
        {rows.map((row) => (
          <div
            key={row.key}
            className="font-mono text-xs text-muted-foreground"
          >
            <span className="inline-block w-24 text-right mr-2 opacity-50">
              {row.label}
            </span>
            <span className="opacity-80 break-all">{row.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
