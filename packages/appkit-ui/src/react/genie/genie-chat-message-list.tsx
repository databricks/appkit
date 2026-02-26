import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { GenieChatMessage } from "./genie-chat-message";
import type { GenieChatStatus, GenieMessageItem } from "./types";

export interface GenieChatMessageListProps {
  /** Array of messages to display */
  messages: GenieMessageItem[];
  /** Current chat status (controls loading indicators and skeleton placeholders) */
  status: GenieChatStatus;
  /** Additional CSS class for the scroll area */
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  ASKING_AI: "Asking AI...",
  EXECUTING_QUERY: "Executing query...",
  FILTERING_RESULTS: "Filtering results...",
  COMPLETED: "Done",
};

function formatStatus(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ").toLowerCase();
}

function StreamingIndicator({ messages }: { messages: GenieMessageItem[] }) {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.id === "") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground px-11">
        <Spinner className="h-3 w-3" />
        <span>{formatStatus(last.status)}</span>
      </div>
    );
  }
  return null;
}

/** Scrollable message list that renders Genie chat messages with auto-scroll, skeleton loaders, and a streaming indicator. */
export function GenieChatMessageList({
  messages,
  status,
  className,
}: GenieChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll only the ScrollArea viewport, not the page
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional triggers for auto-scroll
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages.length, status]);

  return (
    <ScrollArea ref={scrollRef} className={cn("flex-1 min-h-0 p-4", className)}>
      <div className="flex flex-col gap-4">
        {status === "loading-history" && messages.length === 0 && (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-12 w-3/4" />
            <Skeleton className="h-20 w-4/5 self-start" />
            <Skeleton className="h-12 w-2/3 self-end" />
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === "assistant" && msg.id === "" && !msg.content) {
            return null;
          }
          return <GenieChatMessage key={msg.id} message={msg} />;
        })}

        {status === "streaming" && messages.length > 0 && (
          <StreamingIndicator messages={messages} />
        )}

        {messages.length === 0 && status === "idle" && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12">
            Start a conversation by typing a question below.
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
