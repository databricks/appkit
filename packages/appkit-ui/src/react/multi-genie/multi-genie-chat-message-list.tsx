import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { MultiGenieChatMessage } from "./multi-genie-chat-message";
import type { MultiGenieChatStatus, MultiGenieMessageItem } from "./types";

export interface MultiGenieChatMessageListProps {
  messages: MultiGenieMessageItem[];
  status: MultiGenieChatStatus;
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  thinking: "Thinking...",
  routing: "Routing to spaces...",
  querying: "Querying spaces...",
};

function StreamingIndicator({
  messages,
  status,
}: {
  messages: MultiGenieMessageItem[];
  status: MultiGenieChatStatus;
}) {
  const last = messages[messages.length - 1];
  if (
    last?.role === "assistant" &&
    last.id === "" &&
    status !== "idle" &&
    status !== "error"
  ) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground px-11">
        <Spinner className="h-3 w-3" />
        <span>{STATUS_LABELS[status] ?? "Processing..."}</span>
      </div>
    );
  }
  return null;
}

export function MultiGenieChatMessageList({
  messages,
  status,
  className,
}: MultiGenieChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

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
        {messages.map((msg) => (
          <MultiGenieChatMessage key={msg.id || "placeholder"} message={msg} />
        ))}

        {status !== "idle" && status !== "error" && messages.length > 0 && (
          <StreamingIndicator messages={messages} status={status} />
        )}

        {messages.length === 0 && status === "idle" && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12">
            Ask a question that spans multiple data domains.
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
