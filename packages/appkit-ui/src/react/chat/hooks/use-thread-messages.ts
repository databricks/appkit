import { useMemo } from "react";
import type { Message } from "shared";
import type { UseThreadResult } from "./use-thread";

export interface UseThreadMessagesResult {
  messages: Message[];
  loading: boolean;
  error: Error | null;
}

/**
 * Selector hook that exposes `messages` off a `useThread` result without
 * performing any fetch of its own. Pass the return value of {@link useThread}
 * to share a single network call.
 */
export function useThreadMessages(
  threadResult: UseThreadResult,
): UseThreadMessagesResult {
  const messages = useMemo(
    () => threadResult.thread?.messages ?? [],
    [threadResult.thread],
  );
  return {
    messages,
    loading: threadResult.loading,
    error: threadResult.error,
  };
}
