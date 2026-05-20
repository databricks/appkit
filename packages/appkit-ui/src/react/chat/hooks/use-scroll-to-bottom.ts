import { useCallback, useEffect, useState } from "react";

export interface UseScrollToBottomOptions {
  /** Pixels from the bottom that still count as "at bottom". Default 50. */
  threshold?: number;
  /** Reactive value that triggers an auto-scroll when isAtBottom is true. */
  trigger?: unknown;
}

export interface UseScrollToBottomReturn<T extends HTMLElement> {
  /**
   * Ref callback. Attach with `ref={containerRef}` on the scroll
   * container. Re-runs the listener-attach effect whenever the
   * underlying DOM node changes — so containers that mount after the
   * first render (e.g. behind a `loading` gate) still get the listener.
   */
  containerRef: (node: T | null) => void;
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
  // State-backed so changes to the underlying DOM node re-run the
  // listener-attach effect (e.g. when the container mounts after the
  // first render).
  const [element, setElement] = useState<T | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const containerRef = useCallback((node: T | null) => {
    setElement(node);
  }, []);

  useEffect(() => {
    if (!element) return;
    const handleScroll = () => {
      setIsAtBottom(
        element.scrollHeight - element.scrollTop - element.clientHeight <
          threshold,
      );
    };
    element.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => element.removeEventListener("scroll", handleScroll);
  }, [element, threshold]);

  useEffect(() => {
    // `trigger` is referenced only to opt the effect into a re-run when
    // its identity changes (e.g. on every new message during streaming).
    void trigger;
    if (isAtBottom && element) {
      // `instant` here so streaming re-renders don't queue smooth animations.
      element.scrollTo({
        top: element.scrollHeight,
        behavior: "instant",
      });
    }
  }, [trigger, isAtBottom, element]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (!element) return;
      element.scrollTo({ top: element.scrollHeight, behavior });
    },
    [element],
  );

  return { containerRef, isAtBottom, scrollToBottom };
}
