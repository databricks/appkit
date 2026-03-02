import { type KeyboardEvent, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";

export interface GenieChatInputProps {
  /** Callback fired when the user submits a message */
  onSend: (content: string) => void;
  /** Disable the input and send button */
  disabled?: boolean;
  /** Placeholder text shown in the textarea */
  placeholder?: string;
  /** Additional CSS class for the container */
  className?: string;
}

/** Auto-expanding textarea input with a send button for chat messages. Submits on Enter (Shift+Enter for newline). */
export function GenieChatInput({
  onSend,
  disabled = false,
  placeholder = "Ask a question...",
  className,
}: GenieChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const MAX_HEIGHT = 200;

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      const clamped = Math.min(textarea.scrollHeight, MAX_HEIGHT);
      textarea.style.height = `${clamped}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    }
  };

  return (
    <div className={cn("flex gap-2 p-4 border-t shrink-0", className)}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={cn(
          "flex-1 resize-none overflow-hidden rounded-md border border-input bg-background px-3 py-2",
          "text-sm placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      <Button
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        size="default"
        className="self-end"
      >
        Send
      </Button>
    </div>
  );
}
