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
  /** Whether a previous page of older messages exists */
  hasPreviousPage?: boolean;
  /** Callback to fetch the previous page of messages */
  onFetchPreviousPage?: () => void;
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

function getViewport(scrollRef: React.RefObject<HTMLDivElement | null>) {
  return scrollRef.current?.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
}

/**
 * Manages scroll position: scrolls to bottom on append/initial load,
 * preserves position when older messages are prepended.
 */
function useScrollManagement(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  messages: GenieMessageItem[],
) {
  const prevFirstMessageIdRef = useRef<string | null>(null);
  const prevScrollHeightRef = useRef(0);
  const prevMessageCountRef = useRef(0);

  // Keep prevScrollHeightRef fresh when async content (images, embeds)
  // changes the viewport height between renders.
  useEffect(() => {
    const viewport = getViewport(scrollRef);
    if (!viewport) return;

    const observer = new ResizeObserver(() => {
      prevScrollHeightRef.current = viewport.scrollHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only react to message count changes
  useLayoutEffect(() => {
    const viewport = getViewport(scrollRef);
    if (!viewport) return;

    const count = messages.length;
    const countChanged = count !== prevMessageCountRef.current;
    prevMessageCountRef.current = count;

    // Nothing to do if message count didn't change (e.g. status-only transition)
    if (!countChanged) {
      prevScrollHeightRef.current = viewport.scrollHeight;
      return;
    }

    const firstMessageId = messages[0]?.id ?? null;
    const wasPrepend =
      prevFirstMessageIdRef.current !== null &&
      firstMessageId !== prevFirstMessageIdRef.current;

    if (wasPrepend && prevScrollHeightRef.current > 0) {
      // Older messages prepended — preserve scroll position
      const delta = viewport.scrollHeight - prevScrollHeightRef.current;
      viewport.scrollTop += delta;
    } else {
      // Messages appended or initial load — scroll to bottom
      viewport.scrollTop = viewport.scrollHeight;
    }

    prevFirstMessageIdRef.current = firstMessageId;
    prevScrollHeightRef.current = viewport.scrollHeight;
  }, [messages.length]);
}

/**
 * Observes a sentinel element at the top of the scroll area and triggers
 * `onFetchPreviousPage` when the user scrolls to the top (only if content overflows).
 * Returns a ref to attach to the sentinel element.
 */
function useLoadOlderOnScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  shouldObserve: boolean,
  onFetchPreviousPage?: () => void,
) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onFetchPreviousPageRef = useRef(onFetchPreviousPage);
  onFetchPreviousPageRef.current = onFetchPreviousPage;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const viewport = getViewport(scrollRef);
    if (!sentinel || !viewport || !shouldObserve) return;

    // Skip the first callback after (re-)subscribing — the observer fires
    // immediately if the sentinel is visible, which happens right after a
    // page load before the scroll adjustment has pushed it off-screen.
    let initialFire = true;

    const observer = new IntersectionObserver(
      (entries) => {
        if (initialFire) {
          initialFire = false;
          return;
        }
        const isScrollable = viewport.scrollHeight > viewport.clientHeight;
        if (entries[0]?.isIntersecting && isScrollable) {
          onFetchPreviousPageRef.current?.();
        }
      },
      { root: viewport, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollRef, shouldObserve]);

  return sentinelRef;
}

/** Scrollable message list that renders Genie chat messages with auto-scroll, skeleton loaders, and a streaming indicator. */
export function GenieChatMessageList({
  messages,
  status,
  className,
  hasPreviousPage = false,
  onFetchPreviousPage,
}: GenieChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const sentinelRef = useLoadOlderOnScroll(
    scrollRef,
    hasPreviousPage && status !== "loading-older",
    onFetchPreviousPage,
  );
  useScrollManagement(scrollRef, messages);

  const lastMessage = messages[messages.length - 1];
  const showStreamingIndicator =
    status === "streaming" &&
    lastMessage?.role === "assistant" &&
    lastMessage.id === "";

  return (
    <ScrollArea ref={scrollRef} className={cn("flex-1 min-h-0 p-4", className)}>
      <div className="flex flex-col gap-4">
        {hasPreviousPage && <div ref={sentinelRef} className="h-px" />}

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

        {messages
          .filter(
            (msg) => msg.role !== "assistant" || msg.id !== "" || msg.content,
          )
          .map((msg) => (
            <GenieChatMessage key={msg.id} message={msg} />
          ))}

        {showStreamingIndicator && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground px-11">
            <Spinner className="h-3 w-3" />
            <span>{formatStatus(lastMessage.status)}</span>
          </div>
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
