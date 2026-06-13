import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { CheckIcon, CopyIcon, DbIcon, PencilIcon } from "../db-icons";
import { getMessageText } from "./utils";

interface ChatMessageActionsProps<TMessage extends UIMessage = UIMessage> {
  message: TMessage;
  /** When set on user messages, an Edit button toggles edit mode. */
  onEdit?: () => void;
  className?: string;
}

/**
 * Hover-revealed Edit (user only) and always-visible Copy actions
 * shown below a message bubble.
 */
export function ChatMessageActions<TMessage extends UIMessage = UIMessage>({
  message,
  onEdit,
  className,
}: ChatMessageActionsProps<TMessage>) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = getMessageText(message).trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("[ChatMessageActions] copy failed", err);
    }
  }, [message]);

  return (
    <div
      className={cn(
        "flex items-center gap-1",
        isUser ? "-mr-1.5 justify-end" : "-ml-1.5",
        className,
      )}
    >
      {isUser && onEdit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              onClick={onEdit}
              data-testid="message-edit-button"
              aria-label="Edit message"
              className="size-6 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/message:opacity-100 focus-visible:opacity-100"
            >
              <DbIcon icon={PencilIcon} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            onClick={handleCopy}
            data-testid="message-copy-button"
            aria-label={copied ? "Copied" : "Copy message"}
            className="size-6 rounded-lg p-1.5 text-muted-foreground hover:text-foreground"
          >
            {copied ? <DbIcon icon={CheckIcon} /> : <DbIcon icon={CopyIcon} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
      </Tooltip>
    </div>
  );
}
