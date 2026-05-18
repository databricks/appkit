import { ActivityIcon } from "lucide-react";
import {
  toggleInspector,
  useStreamInspector,
} from "../hooks/use-stream-inspector";

/**
 * Floating icon in the bottom-right that opens the Stream Inspector.
 * Complements the ⌘K keyboard shortcut with a discoverable affordance.
 */
export function InspectorToggle() {
  const { records } = useStreamInspector();
  const currentRunEvents = records[0]?.events.length ?? 0;

  return (
    <button
      type="button"
      onClick={toggleInspector}
      aria-label="Toggle stream inspector (⌘K)"
      title="Stream Inspector (⌘K)"
      className="fixed bottom-4 right-4 z-30 rounded-full bg-card border border-border shadow-lg p-3 hover:bg-muted transition-colors flex items-center gap-2"
    >
      <ActivityIcon className="h-4 w-4 text-foreground" />
      {currentRunEvents > 0 && (
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
          {currentRunEvents}
        </span>
      )}
    </button>
  );
}
