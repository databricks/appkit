import { cn } from "../../lib/utils";
import { ChatShimmer } from "./chat-shimmer";

interface ChatAwaitingResponseProps {
  /** Customise the shimmering label. */
  label?: string;
  className?: string;
}

/** "Generating response" placeholder shown before the first chunk arrives. */
export function ChatAwaitingResponse({
  label = "Generating response",
  className,
}: ChatAwaitingResponseProps) {
  return (
    <div
      data-testid="chat-awaiting-response"
      className={cn("flex items-center gap-2", className)}
    >
      <ChatShimmer className="text-base">{label}</ChatShimmer>
    </div>
  );
}
