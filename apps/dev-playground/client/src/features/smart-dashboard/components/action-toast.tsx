import { CheckCircle2Icon } from "lucide-react";
import { useEffect, useState } from "react";

interface ActionToastProps {
  /**
   * Latest dispatcher-surfaced action summary. Each new value bumps a
   * render key so the toast re-animates even if the same message arrives
   * twice (e.g. two identical filter calls in a row).
   */
  message: string | null;
  durationMs?: number;
}

/**
 * Non-intrusive bottom-left toast that confirms every agent-driven UI
 * action. Silent success was the worst failure mode before: an action
 * silently not-applied looked identical to one that worked but didn't
 * show its effect.
 */
export function ActionToast({ message, durationMs = 2800 }: ActionToastProps) {
  const [visible, setVisible] = useState<{ key: number; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (!message) return;
    const key = Date.now();
    setVisible({ key, text: message });
    const t = setTimeout(() => {
      setVisible((v) => (v?.key === key ? null : v));
    }, durationMs);
    return () => {
      clearTimeout(t);
    };
  }, [message, durationMs]);

  if (!visible) return null;

  return (
    <div
      key={visible.key}
      className="fixed bottom-20 left-4 z-30 rounded-full bg-card border border-border shadow-lg px-3 py-1.5 flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200"
    >
      <CheckCircle2Icon className="h-3.5 w-3.5 text-green-500 shrink-0" />
      <span className="text-xs text-foreground">{visible.text}</span>
    </div>
  );
}
