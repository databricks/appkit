import { useMemo } from "react";
import { ChatBubble } from "../chat/chat-bubble";
import { markdownStyles, marked } from "../chat/markdown";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import type { GenieSpaceResultItem, MultiGenieMessageItem } from "./types";

export interface MultiGenieChatMessageProps {
  message: MultiGenieMessageItem;
  className?: string;
}

function GenieSpaceResultCard({ result }: { result: GenieSpaceResultItem }) {
  const queryAttachments = result.attachments.filter(
    (att) => att.query?.title || att.query?.query,
  );

  const html = useMemo(
    () => (result.content ? (marked.parse(result.content) as string) : ""),
    [result.content],
  );

  return (
    <Card className="px-4 py-3 text-xs overflow-hidden">
      <details>
        <summary className="cursor-pointer select-none font-medium flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {result.alias}
          </Badge>
          {result.error ? (
            <span className="text-destructive truncate">
              Error: {result.error}
            </span>
          ) : (
            <span className="text-muted-foreground">Source details</span>
          )}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {result.error && <p className="text-destructive">{result.error}</p>}

          {html && (
            <div
              className={cn(markdownStyles, "text-xs")}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {queryAttachments.map((att) => (
            <div
              key={att.attachmentId ?? "query"}
              className="border rounded p-2"
            >
              <p className="font-medium">{att.query?.title ?? "SQL Query"}</p>
              {att.query?.description && (
                <p className="text-muted-foreground mt-1">
                  {att.query.description}
                </p>
              )}
              {att.query?.query && (
                <pre className="mt-1 p-2 rounded bg-background text-[11px] whitespace-pre-wrap break-all">
                  {att.query.query}
                </pre>
              )}
            </div>
          ))}
        </div>
      </details>
    </Card>
  );
}

export function MultiGenieChatMessage({
  message,
  className,
}: MultiGenieChatMessageProps) {
  const hasGenieSpaceResults =
    message.role !== "user" && message.genieSpaceResults.length > 0;

  return (
    <ChatBubble
      role={message.role}
      content={message.content}
      error={message.error}
      className={className}
    >
      {hasGenieSpaceResults && (
        <>
          <div className="flex gap-1 flex-wrap">
            {message.genieSpaceResults.map((sr) => (
              <Badge
                key={sr.alias}
                variant={sr.error ? "destructive" : "secondary"}
                className="text-[10px]"
              >
                {sr.alias}
              </Badge>
            ))}
          </div>
          <div className="flex flex-col gap-2 w-full min-w-0">
            {message.genieSpaceResults.map((sr) => (
              <GenieSpaceResultCard key={sr.alias} result={sr} />
            ))}
          </div>
        </>
      )}
    </ChatBubble>
  );
}
