import { FolderPlus, Loader2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import type { FileBrowserLabels } from "./types";

/** Props for the NewFolderInput component */
export interface NewFolderInputProps
  extends Omit<React.ComponentProps<"div">, "children" | "onChange"> {
  /** Current folder name value */
  value: string;
  /** Called when folder name changes */
  onChange: (value: string) => void;
  /** Called when the user confirms creation */
  onCreate: () => void;
  /** Called when the user cancels */
  onCancel: () => void;
  /** Whether folder creation is in progress */
  creating?: boolean;
  /** Auto-focus the input on mount */
  autoFocus?: boolean;
  /** Customizable labels */
  labels?: Pick<FileBrowserLabels, "create" | "folderNamePlaceholder">;
}

/** Inline folder-name input with create/cancel actions */
export function NewFolderInput({
  value,
  onChange,
  onCreate,
  onCancel,
  creating,
  autoFocus = true,
  labels,
  className,
  ...props
}: NewFolderInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  return (
    <div
      data-slot="new-folder-input"
      className={cn(
        "flex items-center gap-2 px-4 py-3 border-b bg-muted/30",
        className,
      )}
      {...props}
    >
      <FolderPlus className="h-5 w-5 text-blue-500 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCreate();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={labels?.folderNamePlaceholder ?? "Folder name"}
        className="flex-1 text-sm bg-background border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
        disabled={creating}
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={creating || !value.trim()}
        onClick={onCreate}
      >
        {creating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          (labels?.create ?? "Create")
        )}
      </Button>
      <button
        type="button"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
