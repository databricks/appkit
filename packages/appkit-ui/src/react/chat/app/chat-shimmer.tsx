import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

// Shimmer text via a moving gradient clipped to the glyphs. Keyframes
// are injected once so we don't depend on consumer `globals.css`.

let injected = false;
function ensureKeyframes() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.setAttribute("data-appkit-chat-shimmer", "");
  style.textContent =
    "@keyframes appkit-chat-shimmer-text {0%{background-position:100% 50%}100%{background-position:-100% 50%}}";
  document.head.appendChild(style);
}

interface ChatShimmerProps extends HTMLAttributes<HTMLSpanElement> {}

export function ChatShimmer({
  className,
  children,
  style,
  ...props
}: ChatShimmerProps) {
  ensureKeyframes();
  return (
    <span
      className={cn("inline-block text-transparent", className)}
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--color-neutral-600) 0%, var(--color-neutral-300) 35%, var(--color-neutral-600) 50%, var(--color-neutral-600) 65%, var(--color-neutral-600) 100%)",
        backgroundSize: "200% 100%",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        animation: "appkit-chat-shimmer-text 1.5s linear infinite",
        ...style,
      }}
      {...props}
    >
      {children}
    </span>
  );
}
