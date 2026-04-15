import { ChevronRight, FileIcon, FolderIcon } from "lucide-react";
import { formatFileSize } from "../lib/format";
import { cn } from "../lib/utils";
import { Checkbox } from "../ui/checkbox";
import type { DirectoryEntry } from "./types";

/** Props for the FileEntry component */
export interface FileEntryProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** The directory entry to render */
  entry: DirectoryEntry;
  /** Resolved full path for this entry */
  entryPath: string;
  /** Whether this entry is currently selected for preview */
  isSelected?: boolean;
  /** Custom file size formatter (defaults to formatFileSize) */
  formatSize?: (bytes: number | undefined) => string;
  /** When `files`, show a checkbox for file rows (not directories) */
  selectionMode?: "off" | "files";
  /** Whether the file row is checked for bulk actions */
  checked?: boolean;
  /** Toggle bulk selection for this file */
  onCheckedChange?: (checked: boolean) => void;
  /** Open directory or select file for preview */
  onEntryClick?: () => void;
}

/** Single file or directory row with icon, name, size, and selection state */
export function FileEntry({
  entry,
  entryPath,
  isSelected,
  formatSize = formatFileSize,
  selectionMode = "off",
  checked,
  onCheckedChange,
  onEntryClick,
  className,
  ...props
}: FileEntryProps) {
  const displayName = entry.name ?? entryPath.split("/").pop() ?? "";
  const showCheckbox = selectionMode === "files" && !entry.is_directory;

  return (
    <div
      data-slot="file-entry"
      className={cn(
        "flex items-center gap-0 w-full border-b last:border-b-0 transition-colors",
        isSelected && "bg-muted",
        className,
      )}
      {...props}
    >
      {selectionMode === "files" && (
        <div className="w-10 shrink-0 flex items-center justify-center pl-2">
          {showCheckbox ? (
            <Checkbox
              checked={checked ?? false}
              onCheckedChange={(v) => onCheckedChange?.(v === true)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${displayName}`}
            />
          ) : (
            <span className="inline-block w-4 h-4 shrink-0" aria-hidden />
          )}
        </div>
      )}
      <button
        type="button"
        className={cn(
          "flex flex-1 items-center gap-3 min-w-0 py-3 text-left hover:bg-muted/50 transition-colors",
          selectionMode === "files" ? "pr-4 pl-0" : "px-4",
        )}
        onClick={onEntryClick}
      >
        {entry.is_directory ? (
          <FolderIcon className="h-5 w-5 text-blue-500 shrink-0" />
        ) : (
          <FileIcon className="h-5 w-5 text-muted-foreground shrink-0" />
        )}
        <span className="flex-1 truncate text-sm text-foreground">
          {displayName}
        </span>
        {entry.is_directory && (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        {!entry.is_directory && entry.file_size !== undefined && (
          <span className="text-xs text-muted-foreground shrink-0">
            {formatSize(entry.file_size)}
          </span>
        )}
      </button>
    </div>
  );
}
