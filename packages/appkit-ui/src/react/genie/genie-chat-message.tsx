import { ChatBubble } from "../chat/chat-bubble";
import { Card } from "../ui/card";
import type { GenieAttachmentResponse, GenieMessageItem } from "./types";

export interface GenieChatMessageProps {
  message: GenieMessageItem;
  className?: string;
}

function isQueryAttachment(att: GenieAttachmentResponse): boolean {
  return !!(att.query?.title || att.query?.query);
}

export function GenieChatMessage({
  message,
  className,
}: GenieChatMessageProps) {
  const queryAttachments = message.attachments.filter(isQueryAttachment);

  return (
    <ChatBubble
      role={message.role}
      content={message.content}
      error={message.error}
      className={className}
    >
      {queryAttachments.length > 0 && (
        <div className="flex flex-col gap-2 w-full min-w-0">
          {queryAttachments.map((att) => (
            <Card
              key={att.attachmentId ?? "query"}
              className="px-4 py-3 text-xs overflow-hidden"
            >
              <details>
                <summary className="cursor-pointer select-none font-medium">
                  {att.query?.title ?? "SQL Query"}
                </summary>
                <div className="mt-2 flex flex-col gap-1">
                  {att.query?.description && (
                    <span className="text-muted-foreground">
                      {att.query.description}
                    </span>
                  )}
                  {att.query?.query && (
                    <pre className="mt-1 p-2 rounded bg-background text-[11px] whitespace-pre-wrap break-all">
                      {att.query.query}
                    </pre>
                  )}
                </div>
              </details>
            </Card>
          ))}
        </div>
      )}
    </ChatBubble>
  );
}
