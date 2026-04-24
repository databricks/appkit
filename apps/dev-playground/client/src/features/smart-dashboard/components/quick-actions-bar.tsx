import { BookmarkPlusIcon, EraserIcon, FilterXIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

interface QuickActionsBarProps {
  /**
   * Dispatches a message through the chat pipeline (same `useAgentStream`
   * the text input uses). Keeps the demo narrative honest: clicks are just
   * prefilled prompts — the agent still reasons and the approval gate
   * still fires for destructive actions.
   */
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function QuickActionsBar({
  onSend,
  disabled = false,
}: QuickActionsBarProps) {
  const [savingName, setSavingName] = useState<string | null>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);

  const startSave = useCallback(() => {
    setSavingName("");
    setTimeout(() => saveInputRef.current?.focus(), 0);
  }, []);

  const cancelSave = useCallback(() => {
    setSavingName(null);
  }, []);

  const submitSave = useCallback(() => {
    const name = savingName?.trim();
    if (!name) {
      setSavingName(null);
      return;
    }
    onSend(`Save the current view as "${name}"`);
    setSavingName(null);
  }, [savingName, onSend]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mr-1">
        Quick actions
      </span>

      {savingName === null ? (
        <button
          type="button"
          onClick={startSave}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/5 px-2.5 py-1 text-xs text-red-700 dark:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
          title="Save current view (destructive — requires approval)"
        >
          <BookmarkPlusIcon className="h-3.5 w-3.5" />
          Save view…
        </button>
      ) : (
        <div className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/5 pl-2 pr-1 py-0.5">
          <BookmarkPlusIcon className="h-3.5 w-3.5 text-red-600 shrink-0" />
          <input
            ref={saveInputRef}
            type="text"
            value={savingName}
            onChange={(e) => setSavingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitSave();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelSave();
              }
            }}
            placeholder="Name this view…"
            disabled={disabled}
            className="w-44 bg-transparent border-0 outline-none text-xs text-foreground placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={submitSave}
            disabled={disabled || !savingName.trim()}
            className="text-xs px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={cancelSave}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => onSend("Clear all filters on the dashboard.")}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-muted transition-colors disabled:opacity-50"
      >
        <FilterXIcon className="h-3.5 w-3.5" />
        Clear filters
      </button>

      <button
        type="button"
        onClick={() => onSend("Clear all highlights from the charts.")}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-muted transition-colors disabled:opacity-50"
      >
        <EraserIcon className="h-3.5 w-3.5" />
        Clear highlights
      </button>
    </div>
  );
}
