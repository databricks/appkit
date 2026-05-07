import { useCallback, useEffect, useRef, useState } from "react";

export interface UseScrollToBottomOptions {
  /** Pixels from the bottom that still count as "at bottom". Default 50. */
  threshold?: number;
  /** Reactive value that triggers an auto-scroll when isAtBottom is true. */
  trigger?: unknown;
}

export interface UseScrollToBottomReturn<T extends HTMLElement> {
  containerRef: React.RefObject<T | null>;
  endRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * Tracks whether a scroll container is at the bottom and exposes an
 * imperative `scrollToBottom`. When `trigger` changes and the user was at
 * the bottom, the container auto-scrolls — preserving the typical chat
 * "stick to latest" behavior without overriding manual scroll-up.
 */
export function useScrollToBottom<T extends HTMLElement = HTMLDivElement>({
  threshold = 50,
  trigger,
}: UseScrollToBottomOptions = {}): UseScrollToBottomReturn<T> {
  const containerRef = useRef<T | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold);
  }, [threshold]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    void trigger;
    if (isAtBottom && containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [trigger, isAtBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior,
    });
  }, []);

  return { containerRef, endRef, isAtBottom, scrollToBottom };
}
