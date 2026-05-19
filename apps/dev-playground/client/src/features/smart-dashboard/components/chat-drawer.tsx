import {
  FilterIcon,
  Loader2Icon,
  MessageSquareIcon,
  SendIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingApproval } from "./approval-card";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** When true, this is the in-progress assistant turn being streamed. */
  streaming?: boolean;
}

interface ChatDrawerProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onSend: (message: string) => void;
  /** Rendered inline in the message list for the turn that triggered it. */
  approvalCardForMessage: (messageId: string) => React.ReactNode | null;
  pendingApprovals: PendingApproval[];
  /** Floating affordance: the toggle button also shows a pending-approval dot. */
  unreadCount?: number;
  /** Controlled open state so the parent can auto-open the drawer when a
   *  dashboard interaction (chips, heatmap cells, quick actions, follow-ups)
   *  dispatches a turn the user needs to see. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EXAMPLE_QUERIES = [
  "Filter to November 2016",
  "Highlight the first week of Jan 2016 in red",
  "Save this view as Peak Week",
  "Focus on the fare distribution",
  "Clear all filters and highlights",
];

/**
 * Floating chat drawer. Toggled by the ⌘J keyboard shortcut or the
 * floating message-square button in the bottom-right. Multi-turn
 * conversation history stays mounted in state so previous turns remain
 * visible as the user iterates.
 */
export function ChatDrawer({
  messages,
  isLoading,
  onSend,
  approvalCardForMessage,
  pendingApprovals,
  unreadCount,
  open,
  onOpenChange,
}: ChatDrawerProps) {
  const [input, setInput] = useState("");
  const [showTips, setShowTips] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "j" &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        onOpenChange(!open);
      } else if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  // Auto-open when a new approval arrives so users don't miss it.
  useEffect(() => {
    if (pendingApprovals.length > 0) onOpenChange(true);
  }, [pendingApprovals.length, onOpenChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.content]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const msg = input.trim();
      if (!msg || isLoading) return;
      setInput("");
      setShowTips(false);
      onSend(msg);
    },
    [input, isLoading, onSend],
  );

  const handleExample = useCallback(
    (q: string) => {
      if (isLoading) return;
      setShowTips(false);
      onSend(q);
    },
    [isLoading, onSend],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label="Toggle chat (⌘J)"
        title="Chat with the agent (⌘J)"
        className="fixed bottom-4 right-20 z-30 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors p-3 flex items-center gap-1.5"
      >
        <MessageSquareIcon className="h-4 w-4" />
        <span className="text-xs font-medium">Chat</span>
        {(unreadCount ?? 0) > 0 && (
          <span className="ml-1 inline-flex items-center justify-center w-4 h-4 text-[10px] bg-red-500 text-white rounded-full">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <aside className="fixed bottom-20 right-4 z-40 w-[420px] max-h-[calc(100vh-120px)] flex flex-col rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-200">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
            <div>
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <SparklesIcon className="h-4 w-4 text-primary" />
                Dashboard Agent
              </h2>
              <p className="text-[11px] text-muted-foreground">
                ⌘J toggle · Esc close · full history preserved
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close chat"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-6">
                Ask the agent to filter, highlight, focus, or save the
                dashboard.
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className="space-y-1">
                <MessageBubble message={m} />
                {approvalCardForMessage(m.id)}
              </div>
            ))}

            {isLoading &&
              messages[messages.length - 1]?.role !== "assistant" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-2">
                  <Loader2Icon className="h-3 w-3 animate-spin" />
                  Thinking…
                </div>
              )}

            <div ref={bottomRef} />
          </div>

          {showTips && messages.length === 0 && (
            <div className="px-4 pb-3 border-t border-border">
              <div className="flex items-center gap-1.5 mt-3 mb-2 text-[11px] font-medium text-muted-foreground">
                <FilterIcon className="h-3 w-3" />
                Try one of these
              </div>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLE_QUERIES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => handleExample(q)}
                    disabled={isLoading}
                    className="rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="px-4 py-3 border-t border-border flex gap-2 shrink-0"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the dashboard…"
              disabled={isLoading}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {isLoading ? (
                <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <SendIcon className="h-3.5 w-3.5" />
              )}
            </button>
          </form>
        </aside>
      )}
    </>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm"
        }`}
      >
        {message.content || (message.streaming ? "…" : "")}
      </div>
    </div>
  );
}
