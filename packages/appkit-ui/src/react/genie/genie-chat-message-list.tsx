import { useEffect, useLayoutEffect, useRef } from "react";
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
  /** Whether older messages are available to load */
  hasOlderMessages?: boolean;
  /** Callback to load older messages */
  onLoadOlder?: () => void;
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

function getViewport(scrollRef: React.RefObject<HTMLDivElement | null>) {
  return scrollRef.current?.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
}

/** Scrollable message list that renders Genie chat messages with auto-scroll, skeleton loaders, and a streaming indicator. */
export function GenieChatMessageList({
  messages,
  status,
  className,
  hasOlderMessages = false,
  onLoadOlder,
}: GenieChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevFirstMessageIdRef = useRef<string | null>(null);
  const prevScrollHeightRef = useRef(0);

  // Handle scroll position after messages change.
  // prevScrollHeightRef holds the scrollHeight from the *previous* render's
  // effect, so on a prepend we can compute how much content was added above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional triggers for scroll management
  useLayoutEffect(() => {
    const viewport = getViewport(scrollRef);
    if (!viewport) return;

    const firstMessageId = messages[0]?.id ?? null;
    const wasPrepend =
      prevFirstMessageIdRef.current !== null &&
      firstMessageId !== prevFirstMessageIdRef.current;

    if (wasPrepend && prevScrollHeightRef.current > 0) {
      // Older messages were prepended — preserve scroll position
      const delta = viewport.scrollHeight - prevScrollHeightRef.current;
      viewport.scrollTop += delta;
    } else {
      // New messages appended or initial load — scroll to bottom
      viewport.scrollTop = viewport.scrollHeight;
    }

    // Update refs *after* scroll adjustment so they're correct for the next render
    prevFirstMessageIdRef.current = firstMessageId;
    prevScrollHeightRef.current = viewport.scrollHeight;
  }, [messages.length, status]);

  // Auto-trigger loading older messages when scrolling to the top
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;

  const shouldObserve = hasOlderMessages && status !== "loading-older";

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const viewport = getViewport(scrollRef);
    if (!sentinel || !viewport || !shouldObserve) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Only trigger when the user has actually scrolled near the top,
        // not when content is too short to fill the viewport.
        const isScrollable = viewport.scrollHeight > viewport.clientHeight;
        if (entries[0]?.isIntersecting && isScrollable) {
          onLoadOlderRef.current?.();
        }
      },
      { root: viewport, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [shouldObserve]);

  return (
    <ScrollArea ref={scrollRef} className={cn("flex-1 min-h-0 p-4", className)}>
      <div className="flex flex-col gap-4">
        {/* Sentinel element for auto-triggering load when scrolled to top */}
        {hasOlderMessages && <div ref={sentinelRef} className="h-px" />}

        {status === "loading-older" && (
          <div className="flex items-center justify-center gap-2 py-2">
            <Spinner className="h-3 w-3" />
            <span className="text-sm text-muted-foreground">
              Loading older messages...
            </span>
          </div>
        )}

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
