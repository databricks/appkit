import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatStatus, UIMessage } from "ai";
import { type FormEvent, type ReactNode, useCallback, useState } from "react";

export interface ChatInputRenderProps {
  value: string;
  onChange: (value: string) => void;
  submit: (e?: FormEvent) => void;
  isStreaming: boolean;
  stop: () => void;
  canSubmit: boolean;
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => void;
}

export interface ChatInputProps<TMessage extends UIMessage = UIMessage> {
  /** Pass `sendMessage` straight through from `useChat` / `Conversation`. */
  onSubmit: UseChatHelpers<TMessage>["sendMessage"];
  /** Pass `status` from the chat helpers — drives `isStreaming`. */
  status: ChatStatus;
  /** Pass `stop` from the chat helpers — exposed back to the render prop. */
  stop: () => void;
  /** Render prop receiving the input state and submit/stop handlers. */
  children: (props: ChatInputRenderProps) => ReactNode;
}

/**
 * Render-prop component that owns the input string, debounces submit,
 * handles `Enter` / `Shift+Enter` / IME composition, and forwards an
 * `isStreaming` flag for stop-button toggles. Wire `onSubmit`, `status`,
 * and `stop` from `useChat` / `Conversation`; the render prop returns a
 * `submit` callback you can attach to either a form `onSubmit` or a
 * button `onClick`.
 */
export function ChatInput<TMessage extends UIMessage = UIMessage>({
  onSubmit,
  status,
  stop,
  children,
}: ChatInputProps<TMessage>) {
  const [value, setValue] = useState("");
  const isStreaming = status === "streaming";

  const submit = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      // Mirror the button's `canSubmit` gate so the Enter-key path
      // can't queue a send mid-stream.
      if (isStreaming) return;
      const trimmed = value.trim();
      if (!trimmed) return;
      onSubmit({ text: trimmed });
      setValue("");
    },
    [value, onSubmit, isStreaming],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (e.key === "Enter") {
        if (e.nativeEvent.isComposing) return;
        if (e.shiftKey) return;
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return children({
    value,
    onChange: setValue,
    submit,
    isStreaming,
    stop,
    canSubmit: value.trim().length > 0 && !isStreaming,
    handleKeyDown,
  });
}
