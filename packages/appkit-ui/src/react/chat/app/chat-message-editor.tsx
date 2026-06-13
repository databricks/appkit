import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Textarea } from "../../ui/textarea";
import { getMessageText } from "./utils";

interface ChatMessageEditorProps<TMessage extends UIMessage = UIMessage> {
  message: TMessage;
  onCancel: () => void;
  setMessages: UseChatHelpers<TMessage>["setMessages"];
  regenerate: UseChatHelpers<TMessage>["regenerate"];
}

const editorButtonBase =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-base ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer h-8 px-3 py-1";

const editorButtonDefault =
  "text-foreground hover:bg-action-default-background-hover border border-neutral-300 hover:border-primary active:bg-action-default-background-press";

const editorButtonPrimary =
  "bg-primary text-background hover:bg-action-primary-background-hover active:bg-action-primary-background-press";

/**
 * Inline editor for a user message. Replaces the message text, drops
 * everything after it, and triggers a regeneration.
 */
export function ChatMessageEditor<TMessage extends UIMessage = UIMessage>({
  message,
  onCancel,
  setMessages,
  regenerate,
}: ChatMessageEditorProps<TMessage>) {
  const [draft, setDraft] = useState(() => getMessageText(message));

  const handleSubmit = async () => {
    setMessages((messages) => {
      const index = messages.findIndex((m) => m.id === message.id);
      if (index === -1) return messages;
      const updated = {
        ...message,
        parts: [{ type: "text", text: draft }],
      } as TMessage;
      return [...messages.slice(0, index), updated];
    });
    onCancel();
    // `useChat` surfaces failures via `chat.error`; swallow here so the
    // promise doesn't reject unhandled.
    try {
      await regenerate();
    } catch (err) {
      console.error("[ChatMessageEditor] regenerate failed", err);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        data-testid="message-editor"
        autoFocus
        className="w-full resize-none rounded-2xl bg-secondary text-base outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="flex flex-row justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(editorButtonBase, editorButtonDefault)}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="message-editor-send-button"
          disabled={draft.trim().length === 0}
          onClick={handleSubmit}
          className={cn(editorButtonBase, editorButtonPrimary)}
        >
          Send
        </button>
      </div>
    </div>
  );
}
