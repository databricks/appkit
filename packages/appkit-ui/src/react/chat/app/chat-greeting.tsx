import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface ChatGreetingProps {
  /** Headline shown when the conversation is empty. */
  title?: ReactNode;
  /** Optional subtitle below the headline. */
  subtitle?: ReactNode;
  className?: string;
}

/** Empty-state hero shown above the composer before the first message. */
export function ChatGreeting({
  title = "What would you like to know?",
  subtitle,
  className,
}: ChatGreetingProps) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col items-center justify-center gap-2 px-4 text-center mb-6",
        className,
      )}
    >
      <div className="text-lg font-semibold text-foreground md:text-xl">
        {title}
      </div>
      {subtitle && (
        <div className="max-w-xl text-sm text-muted-foreground md:text-base">
          {subtitle}
        </div>
      )}
    </div>
  );
}
