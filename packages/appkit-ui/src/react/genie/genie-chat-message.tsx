import { marked } from "marked";
import { useMemo } from "react";
import { cn } from "../lib/utils";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Card } from "../ui/card";
import { GenieQueryVisualization } from "./genie-query-visualization";
import type { GenieAttachmentResponse, GenieMessageItem } from "./types";

/**
 * Using `marked` instead of `react-markdown` because `react-markdown` depends on
 * `micromark-util-symbol` which has broken ESM exports with `rolldown-vite`.
 * Content comes from our own Genie API so `dangerouslySetInnerHTML` is safe.
 */
marked.setOptions({ breaks: true, gfm: true });

const markdownStyles = cn(
  "text-sm",
  "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0",
  "[&_pre]:bg-background/50 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_pre]:overflow-x-auto",
  "[&_code]:text-xs [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded",
  "[&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1",
  "[&_table]:border-collapse [&_th]:border [&_td]:border",
  "[&_th]:border-border [&_td]:border-border",
  "[&_a]:underline",
);

export interface GenieChatMessageProps {
  /** The message object to render */
  message: GenieMessageItem;
  /** Additional CSS class */
  className?: string;
}

function isQueryAttachment(att: GenieAttachmentResponse): boolean {
  return !!(att.query?.title || att.query?.query);
}

/** Renders a single Genie message bubble with optional expandable SQL query attachments. */
export function GenieChatMessage({
  message,
  className,
}: GenieChatMessageProps) {
  const isUser = message.role === "user";
  const queryAttachments = message.attachments.filter(isQueryAttachment);
  const html = useMemo(
    () => (message.content ? (marked.parse(message.content) as string) : ""),
    [message.content],
  );

  return (
    <div
      className={cn(
        "flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row",
        className,
      )}
    >
      <Avatar className="h-8 w-8 shrink-0 mt-1">
        <AvatarFallback
          className={cn(
            "text-xs font-medium",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          {isUser ? "You" : "AI"}
        </AvatarFallback>
      </Avatar>

      <div
        className={cn(
          "flex flex-col gap-2 max-w-[80%] min-w-0 overflow-hidden",
          isUser ? "items-end" : "items-start",
        )}
      >
        <Card
          className={cn(
            "px-4 py-3 max-w-full overflow-hidden",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          {html && (
            <div
              className={markdownStyles}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {message.error && (
            <p className="text-sm text-destructive mt-1">{message.error}</p>
          )}
        </Card>

        {queryAttachments.length > 0 && (
          <div className="flex flex-col gap-2 w-full min-w-0">
            {queryAttachments.map((att) => {
              const key = att.attachmentId ?? "query";
              const queryResult = att.attachmentId
                ? message.queryResults.get(att.attachmentId)
                : undefined;

              return (
                <div key={key} className="flex flex-col gap-2">
                  <Card className="px-4 py-3 text-xs overflow-hidden shadow-none">
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
                  {queryResult != null && (
                    <Card className="px-4 py-3 overflow-hidden">
                      <GenieQueryVisualization data={queryResult} />
                    </Card>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
