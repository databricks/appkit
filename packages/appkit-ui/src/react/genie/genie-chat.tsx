import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { GenieChatInput } from "./genie-chat-input";
import { GenieChatMessageList } from "./genie-chat-message-list";
import type { GenieChatProps } from "./types";
import { useGenieChat } from "./use-genie-chat";

export function GenieChat({
  alias,
  basePath,
  placeholder,
  className,
}: GenieChatProps) {
  const { messages, status, error, sendMessage, reset } = useGenieChat({
    alias,
    basePath,
  });

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      <GenieChatMessageList messages={messages} status={status} />

      {error && (
        <div className="shrink-0 px-4 py-2 text-sm text-destructive bg-destructive/10 border-t">
          {error}
        </div>
      )}

      <GenieChatInput
        onSend={sendMessage}
        disabled={status === "streaming" || status === "loading-history"}
        placeholder={placeholder}
      />

      {messages.length > 0 && (
        <div className="shrink-0 px-4 pb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            className="text-xs text-muted-foreground"
          >
            New conversation
          </Button>
        </div>
      )}
    </div>
  );
}
