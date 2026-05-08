import { useCallback, useEffect, useRef, useState } from "react";

export interface UseScrollToBottomOptions {
  /** Pixels from the bottom that still count as "at bottom". Default 50. */
  threshold?: number;
  /** Reactive value that triggers an auto-scroll when isAtBottom is true. */
  trigger?: unknown;
}

export interface UseScrollToBottomReturn<T extends HTMLElement> {
  containerRef: React.RefObject<T | null>;
  isAtBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * Sticks a scroll container to the bottom on `trigger` changes, unless
 * the user has scrolled up.
 */
export function useScrollToBottom<T extends HTMLElement = HTMLDivElement>({
  threshold = 50,
  trigger,
}: UseScrollToBottomOptions = {}): UseScrollToBottomReturn<T> {
  const containerRef = useRef<T | null>(null);
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
    // `trigger` is referenced only to opt the effect into a re-run when
    // its identity changes (e.g. on every new message during streaming).
    void trigger;
    if (isAtBottom && containerRef.current) {
      // `instant` here so streaming re-renders don't queue smooth animations.
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "instant",
      });
    }
  }, [trigger, isAtBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior,
    });
  }, []);

  return { containerRef, isAtBottom, scrollToBottom };
}
