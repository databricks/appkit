import { getPluginClientConfig } from "@databricks/appkit-ui/js";
import { Button } from "@databricks/appkit-ui/react";
import {
  ChatInput,
  ChatProvider,
  Conversation,
  generateUUID,
} from "@databricks/appkit-ui/react/chat";
import { createFileRoute } from "@tanstack/react-router";
import type { UIMessageChunk } from "ai";
import { useCallback, useRef, useState } from "react";
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
 * doesn't share the chat thread with the conversational chat flow and
 * there's nothing to gain from migrating it to the chat building blocks.
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
 * Concatenate all `text` parts of a message — the AI SDK keeps text
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
  // The dev-playground server doesn't expose `/config` or `/session`
  // endpoints, so we hand-roll the provider state. `apiBase` is unused
  // for the chat call itself (overridden via `api` on the conversation)
  // and only feeds the disabled history/feedback paths.
  return (
    <ChatProvider
      apiBase="/api/agents"
      features={{ chatHistory: false, feedback: false }}
      session={{ user: null }}
    >
      <AgentRouteInner />
    </ChatProvider>
  );
}

function AgentRouteInner() {
  // Stable chat id seeded once per route mount. 's agents plugin
  // maps it 1:1 to its `threadId`, so a remount = a fresh thread.
  const [chatId] = useState(() => generateUUID());
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  );
  // Chronological log of every UIMessageChunk received over the stream.
  // Fed by `onStreamPart` so it matches the raw-SSE fidelity of the
  // pre-AI-SDK implementation (one row per chunk, not per message-part).
  // We stamp each entry with a monotonic id so React keys stay stable
  // without leaking through the chunk shape itself.
  const [streamLog, setStreamLog] = useState<
    Array<{ id: number; chunk: UIMessageChunk }>
  >([]);
  const nextChunkIdRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Agent Chat</h1>
            <p className="text-base text-muted-foreground">
              AI agent with auto-discovered tools from all plugins.
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

        <Conversation<VercelAIAgentUIMessage>
          id={chatId}
          api="/api/agents/chat"
          headers={{ Accept: VERCEL_AI_UI_MESSAGE_STREAM_ACCEPT }}
          onData={(part) => {
            if (part.type === "data-approval-pending") {
              const payload = part.data as ApprovalPendingPayload;
              setPendingApprovals((prev) =>
                prev.some((p) => p.approvalId === payload.approvalId)
                  ? prev
                  : [...prev, payload],
              );
            }
          }}
          onStreamPart={(chunk) =>
            setStreamLog((prev) => [
              ...prev,
              { id: nextChunkIdRef.current++, chunk },
            ])
          }
        >
          {({ messages, status, error, sendMessage, stop, containerRef }) => {
            const isLoading = status === "submitted" || status === "streaming";
            // The AI SDK creates the assistant `UIMessage` stub the moment
            // the server emits its `start` chunk — well before any
            // text-delta arrives. Show "Thinking..." until the assistant
            // has produced visible text. Tool-only turns therefore keep
            // the indicator up until the model speaks.
            const lastMessage = messages[messages.length - 1];
            const lastAssistantHasText =
              lastMessage?.role === "assistant" &&
              messageBodyText(lastMessage).length > 0;
            const showThinking =
              isLoading &&
              pendingApprovals.length === 0 &&
              !lastAssistantHasText;

            return (
              <div className="flex gap-6 h-[700px]">
                <div className="flex-1 flex flex-col border rounded-lg bg-card min-w-0">
                  <div
                    ref={containerRef}
                    className="flex-1 overflow-y-auto p-4 space-y-4"
                  >
                    {messages.length === 0 && (
                      <div className="text-center text-muted-foreground py-20">
                        <p className="text-lg">
                          Send a message to start a conversation
                        </p>
                        <p className="text-sm mt-2">
                          The agent can use analytics, files, genie, and
                          lakebase tools.
                          {hasAutocomplete &&
                            " Start typing for inline suggestions."}
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
                            msg.role === "user"
                              ? "justify-end"
                              : "justify-start"
                          }`}
                        >
                          <div
                            className={`max-w-[85%] rounded-lg px-4 py-2 ${
                              msg.role === "user"
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted"
                            }`}
                          >
                            <p className="whitespace-pre-wrap text-sm">
                              {body}
                            </p>
                          </div>
                        </div>
                      );
                    })}

                    {pendingApprovals.map((approval) => (
                      <div
                        key={approval.approvalId}
                        className="flex justify-start"
                      >
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
                    <ChatInput<VercelAIAgentUIMessage>
                      onSubmit={(message) => {
                        // Cancel any in-flight or debounced autocomplete
                        // before the input clears — otherwise the 500ms
                        // timer scheduled on the last keystroke fires
                        // post-submit and asks for suggestions on stale
                        // text (or, after the input clears, on "" — which
                        // surfaces as a phantom "/chat" request).
                        clearSuggestion();
                        sendMessage(message);
                      }}
                      status={status}
                      onStop={stop}
                    >
                      {({
                        value,
                        onChange,
                        submit,
                        isStreaming,
                        canSubmit,
                        handleKeyDown,
                      }) => (
                        <form onSubmit={submit} className="flex gap-2">
                          <div className="flex-1 relative">
                            <div
                              aria-hidden
                              className="absolute inset-0 px-3 py-2 text-sm pointer-events-none whitespace-pre-wrap break-words overflow-hidden"
                            >
                              <span className="invisible">{value}</span>
                              <span className="text-muted-foreground/40">
                                {suggestion}
                              </span>
                            </div>
                            <textarea
                              ref={inputRef}
                              value={value}
                              onChange={(e) => {
                                onChange(e.target.value);
                                requestSuggestion(e.target.value);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Tab" && suggestion) {
                                  e.preventDefault();
                                  onChange(value + suggestion);
                                  clearSuggestion();
                                  inputRef.current?.focus();
                                  return;
                                }
                                if (e.key === "Escape" && suggestion) {
                                  clearSuggestion();
                                  return;
                                }
                                // While a suggestion is showing, don't let
                                // Enter submit — let the Tab path absorb
                                // it. Otherwise delegate to the headless
                                // input's default Enter-to-submit handler.
                                if (suggestion) return;
                                handleKeyDown(e);
                              }}
                              placeholder="Ask a question..."
                              disabled={isStreaming}
                              rows={1}
                              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 resize-none"
                            />
                          </div>
                          {isStreaming ? (
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
                              disabled={!canSubmit}
                              className="self-end"
                            >
                              Send
                            </Button>
                          )}
                        </form>
                      )}
                    </ChatInput>
                  </div>
                </div>

                <EventStreamPanel chunks={streamLog} />
              </div>
            );
          }}
        </Conversation>
      </div>
    </div>
  );
}

/**
 * Right-hand debug panel. Renders one row per `UIMessageChunk` exactly as
 * it arrived from the transport — `text-delta`s are NOT coalesced, so the
 * panel doubles as a faithful trace of the wire stream (matching what the
 * legacy raw-SSE viewer used to show).
 */
function EventStreamPanel({
  chunks,
}: {
  chunks: Array<{ id: number; chunk: UIMessageChunk }>;
}) {
  return (
    <div className="w-80 shrink-0 flex flex-col border rounded-lg bg-card">
      <div className="px-3 py-2 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">
          Event Stream
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground/60">
          {chunks.length} chunk{chunks.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {chunks.length === 0 && (
          <p className="text-xs text-muted-foreground/50 text-center py-8">
            Events will appear here
          </p>
        )}
        {chunks.map(({ id, chunk }) => {
          const { label, detail } = describeChunk(chunk);
          return (
            <div key={id} className="font-mono text-xs text-muted-foreground">
              <span className="inline-block w-24 text-right mr-2 opacity-50">
                {label}
              </span>
              <span className="opacity-80 break-all">{detail}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Format a `UIMessageChunk` into a (label, detail) pair for the debug
 * panel. The chunk discriminator is the AI SDK's wire-level event name
 * (`text-delta`, `reasoning-delta`, `tool-input-available`, `data-*`,
 * etc.); see {@link https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol#ui-message-chunks}.
 */
function describeChunk(chunk: UIMessageChunk): {
  label: string;
  detail: string;
} {
  const c = chunk as Record<string, unknown> & { type: string };
  if (c.type === "text-delta") {
    return { label: "text-Δ", detail: String(c.delta ?? "").slice(0, 80) };
  }
  if (c.type === "reasoning-delta") {
    return {
      label: "reasoning-Δ",
      detail: String(c.delta ?? "").slice(0, 80),
    };
  }
  if (c.type === "tool-input-available") {
    return {
      label: `tool→ ${String(c.toolName ?? "?")}`,
      detail: safeStringify(c.input).slice(0, 80),
    };
  }
  if (c.type === "tool-output-available") {
    return {
      label: `tool← ${String(c.toolName ?? "?")}`,
      detail: safeStringify(c.output).slice(0, 80),
    };
  }
  if (c.type.startsWith("data-")) {
    return {
      label: c.type.replace(/^data-/, "data:"),
      detail: safeStringify(c.data).slice(0, 80),
    };
  }
  return { label: c.type, detail: "" };
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
