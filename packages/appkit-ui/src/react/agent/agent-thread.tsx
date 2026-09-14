import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { useAgentThread } from "../hooks/use-agent-thread";
import { usePluginClientConfig } from "../hooks/use-plugin-config";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";

interface AgentsClientConfig {
  agents?: string[];
  defaultAgent?: string | null;
}

export interface AgentThreadProps {
  /** Thread to open. Omit for a new conversation (id assigned on first send). */
  threadId?: string;
  /** Agent to route turns to. Defaults to the plugin's default agent. */
  agent?: string;
  /** Base path the agents plugin is mounted under. Default `"/api/agents"`. */
  basePath?: string;
  /** Composer placeholder. */
  placeholder?: string;
  /** Mirror the active thread id in the URL (default off). */
  persistInUrl?: boolean;
  /** Fired when a brand-new thread gets its server-assigned id (uncontrolled use). */
  onThreadCreated?: (threadId: string) => void;
  /** Fired when an assistant turn finishes streaming (e.g. to refresh a list). */
  onTurnComplete?: () => void;
  /** Root container class. */
  className?: string;
}

/**
 * A single agent conversation: transcript + composer. Owns
 * {@link useAgentThread} (history load + streaming). Pair with
 * {@link ThreadList} — the page holds the active thread id and passes it here.
 *
 * @example
 * ```tsx
 * <AgentThread threadId={active} onThreadCreated={setActive} onTurnComplete={refetch} />
 * ```
 */
export function AgentThread({
  threadId,
  agent,
  basePath,
  placeholder = "Ask a question...",
  persistInUrl,
  onThreadCreated,
  onTurnComplete,
  className,
}: AgentThreadProps) {
  const config = usePluginClientConfig<AgentsClientConfig>("agents");
  const resolvedAgent =
    agent ?? config.defaultAgent ?? config.agents?.[0] ?? "";

  const {
    messages,
    threadId: activeThreadId,
    loading,
    isStreaming,
    error,
    send,
  } = useAgentThread(threadId, {
    agent: resolvedAgent,
    basePath,
    persistInUrl,
  });

  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // Notify the parent when an uncontrolled conversation is first created.
  const prevActive = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId && !prevActive.current && activeThreadId) {
      onThreadCreated?.(activeThreadId);
    }
    prevActive.current = activeThreadId;
  }, [activeThreadId, threadId, onThreadCreated]);

  // Notify the parent when a turn finishes (true -> false).
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) onTurnComplete?.();
    wasStreaming.current = isStreaming;
  }, [isStreaming, onTurnComplete]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    void send(trimmed);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // "Thinking" once a turn is in flight but before the first token lands.
  const awaitingFirstToken =
    isStreaming && messages[messages.length - 1]?.role !== "assistant";

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-4">
          {loading && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {!loading && messages.length === 0 && (
            <p className="py-20 text-center text-muted-foreground">
              Send a message to start a conversation
            </p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "flex",
                m.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap",
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted",
                )}
              >
                {m.content}
              </div>
            </div>
          ))}
          {awaitingFirstToken && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-4 py-2">
                <span className="animate-pulse text-sm text-muted-foreground">
                  Thinking...
                </span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      {error && (
        <div className="shrink-0 border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex shrink-0 gap-2 border-t p-4">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={isStreaming}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button
          onClick={submit}
          disabled={isStreaming || !input.trim()}
          className="self-end"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
