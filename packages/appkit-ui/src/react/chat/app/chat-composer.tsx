import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatStatus, UIMessage } from "ai";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { ArrowUpIcon, DbIcon, StopIcon } from "../db-icons";
import { ChatInput } from "../headless/chat-input";

export interface ChatComposerProps<TMessage extends UIMessage = UIMessage> {
  sendMessage: UseChatHelpers<TMessage>["sendMessage"];
  status: ChatStatus;
  stop: () => void;
  placeholder?: string;
  /** Caption below the input. Pass `null` to suppress. */
  caption?: string | null;
  className?: string;
}

/**
 * Default composer. Built on the `<ChatInput>` headless primitive so
 * Enter-to-submit, IME composition, and value clearing match
 * roll-your-own composers.
 */
export function ChatComposer<TMessage extends UIMessage = UIMessage>({
  sendMessage,
  status,
  stop,
  placeholder = "Ask a question…",
  caption = "Always review the accuracy of responses.",
  className,
}: ChatComposerProps<TMessage>) {
  return (
    <ChatInput<TMessage> onSubmit={sendMessage} status={status} stop={stop}>
      {({ value, onChange, submit, isStreaming, canSubmit, handleKeyDown }) => (
        <div className={cn("flex w-full flex-col gap-1.5", className)}>
          <div className="w-full rounded-[24px] border-4 border-black/[0.02] dark:border-white/[0.02]">
            <form
              onSubmit={submit}
              className={cn(
                "rounded-[24px] border border-black/[0.08] bg-background/75 p-3 backdrop-blur-sm",
                "transition-all duration-200",
                "dark:border-white/[0.08]",
                "focus-within:border-ring/40 focus-within:shadow-sm",
              )}
            >
              <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={isStreaming}
                rows={1}
                className={cn(
                  "w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm outline-none",
                  "field-sizing-content max-h-[8lh]",
                  "placeholder:text-muted-foreground",
                  "focus:outline-none focus-visible:ring-0",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              />
              <div className="flex items-center justify-end pt-1">
                {isStreaming ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="default"
                    onClick={stop}
                    aria-label="Stop generating"
                    className="rounded-full"
                  >
                    <DbIcon icon={StopIcon} />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    size="icon-sm"
                    disabled={!canSubmit}
                    aria-label="Send message"
                    className="rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:bg-muted disabled:text-muted-foreground"
                  >
                    <DbIcon icon={ArrowUpIcon} />
                  </Button>
                )}
              </div>
            </form>
          </div>
          {caption && (
            <p className="text-center text-sm text-muted-foreground">
              {caption}
            </p>
          )}
        </div>
      )}
    </ChatInput>
  );
}
