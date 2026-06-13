import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { ChevronDownIcon } from "../db-icons";
import { ChatMarkdown } from "./chat-markdown";
import { ChatShimmer } from "./chat-shimmer";

const AUTO_CLOSE_DELAY_MS = 500;
const MS_IN_S = 1000;

interface ChatReasoningProps {
  /** Reasoning text streamed as `appkit.thinking` events. */
  text: string;
  /** True while the model is still emitting reasoning deltas. */
  isStreaming: boolean;
  className?: string;
}

/**
 * Collapsible "Thinking…" panel. Auto-opens while streaming, auto-closes
 * shortly after, and shows elapsed time once finished.
 */
export function ChatReasoning({
  text,
  isStreaming,
  className,
}: ChatReasoningProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);

  useEffect(() => {
    if (isStreaming) {
      if (startTime === null) setStartTime(Date.now());
      // Re-arm for multi-round reasoning within a single part: a fresh
      // streaming round reopens the panel and clears the prior duration.
      setHasAutoClosed(false);
      setIsOpen(true);
      setDuration(0);
    } else if (startTime !== null) {
      setDuration(Math.round((Date.now() - startTime) / MS_IN_S));
      setStartTime(null);
    }
  }, [isStreaming, startTime]);

  useEffect(() => {
    if (!isStreaming && isOpen && !hasAutoClosed) {
      const t = setTimeout(() => {
        setIsOpen(false);
        setHasAutoClosed(true);
      }, AUTO_CLOSE_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [isStreaming, isOpen, hasAutoClosed]);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn("not-prose", className)}
    >
      <CollapsibleTrigger className="group/reasoning flex cursor-pointer items-center gap-1.5 text-base transition-colors hover:text-foreground">
        {isStreaming ? (
          <ChatShimmer className="text-base font-medium">
            Thinking...
          </ChatShimmer>
        ) : (
          <span className="font-medium text-muted-foreground">
            {duration > 0 ? `Thought for ${duration}s` : "Thoughts"}
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "size-3 text-muted-foreground transition-transform",
            isOpen ? "rotate-180" : "rotate-0",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "mt-2 border-l border-border pl-4 text-base text-muted-foreground",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2",
          "outline-hidden",
        )}
      >
        <ChatMarkdown>{text}</ChatMarkdown>
      </CollapsibleContent>
    </Collapsible>
  );
}
