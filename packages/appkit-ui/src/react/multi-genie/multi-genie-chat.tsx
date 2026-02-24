import { GenieChatInput } from "../genie/genie-chat-input";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { MultiGenieChatMessageList } from "./multi-genie-chat-message-list";
import type { MultiGenieChatProps } from "./types";
import { useMultiGenieChat } from "./use-multi-genie-chat";

export function MultiGenieChat({
  basePath,
  placeholder,
  className,
}: MultiGenieChatProps) {
  const { messages, status, error, sendMessage, reset } = useMultiGenieChat({
    basePath,
  });

  const isStreaming =
    status === "thinking" || status === "routing" || status === "querying";

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      <MultiGenieChatMessageList messages={messages} status={status} />

      {error && (
        <div className="shrink-0 px-4 py-2 text-sm text-destructive bg-destructive/10 border-t">
          {error}
        </div>
      )}

      <GenieChatInput
        onSend={sendMessage}
        disabled={isStreaming}
        placeholder={placeholder ?? "Ask a question across your data spaces..."}
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
