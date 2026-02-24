import type { ReactNode } from "react";
import { useMemo } from "react";
import { cn } from "../lib/utils";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Card } from "../ui/card";
import { markdownStyles, marked } from "./markdown";

export interface ChatBubbleProps {
  role: "user" | "assistant";
  content: string;
  error?: string;
  /** Rendered below the main bubble card (e.g. query attachments, space results) */
  children?: ReactNode;
  className?: string;
}

export function ChatBubble({
  role,
  content,
  error,
  children,
  className,
}: ChatBubbleProps) {
  const isUser = role === "user";
  const html = useMemo(
    () => (content ? (marked.parse(content) as string) : ""),
    [content],
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
          "flex flex-col gap-2 max-w-[80%] min-w-0",
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

          {error && <p className="text-sm text-destructive mt-1">{error}</p>}
        </Card>

        {children}
      </div>
    </div>
  );
}
