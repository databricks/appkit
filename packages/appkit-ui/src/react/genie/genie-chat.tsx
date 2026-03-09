import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { GenieChatInput } from "./genie-chat-input";
import { GenieChatMessageList } from "./genie-chat-message-list";
import type { GenieChatProps } from "./types";
import { useGenieChat } from "./use-genie-chat";

/** Full-featured chat interface for a single Databricks AI/BI Genie space. Handles message streaming, conversation history, and auto-reconnection via SSE. */
export function GenieChat({
  alias,
  basePath,
  placeholder,
  className,
}: GenieChatProps) {
  const {
    messages,
    status,
    error,
    sendMessage,
    reset,
    hasPreviousPage,
    fetchPreviousPage,
  } = useGenieChat({
    alias,
    basePath,
  });

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      {messages.length > 0 && (
        <div className="shrink-0 flex justify-end px-4 pt-3 pb-1">
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

      <GenieChatMessageList
        messages={messages}
        status={status}
        hasPreviousPage={hasPreviousPage}
        onFetchPreviousPage={fetchPreviousPage}
      />

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
    </div>
  );
}
