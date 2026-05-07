import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatStatus, UIMessage } from "ai";
import {
  useCallback,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { ChatMessage } from "../types";

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

export interface ChatInputProps<
  TMessage extends UIMessage = ChatMessage,
> {
  onSubmit: UseChatHelpers<TMessage>["sendMessage"];
  status: ChatStatus;
  onStop: () => void;
  children: (props: ChatInputRenderProps) => ReactNode;
}

export function ChatInput<
  TMessage extends UIMessage = ChatMessage,
>({
  onSubmit,
  status,
  onStop,
  children,
}: ChatInputProps<TMessage>) {
  const [value, setValue] = useState("");
  const isStreaming = status === "streaming";

  const submit = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) return;

      // Use the AI SDK's `{ text }` shorthand. Internally this is
      // promoted to a single `text` part on a `user` message — the
      // wire shape is identical to manually constructing
      // `{ role: "user", parts: [{ type: "text", text }] }`.
      onSubmit({ text: trimmed });
      setValue("");
    },
    [value, onSubmit],
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
    stop: onStop,
    canSubmit: value.trim().length > 0 && !isStreaming,
    handleKeyDown,
  });
}
