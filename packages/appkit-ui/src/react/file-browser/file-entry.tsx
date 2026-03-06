import { ChevronRight, FileIcon, FolderIcon } from "lucide-react";
import { formatFileSize } from "../lib/format";
import { cn } from "../lib/utils";
import type { DirectoryEntry } from "./types";

/** Props for the FileEntry component */
export interface FileEntryProps
  extends Omit<React.ComponentProps<"button">, "children"> {
  /** The directory entry to render */
  entry: DirectoryEntry;
  /** Resolved full path for this entry */
  entryPath: string;
  /** Whether this entry is currently selected */
  isSelected?: boolean;
  /** Custom file size formatter (defaults to formatFileSize) */
  formatSize?: (bytes: number | undefined) => string;
}

/** Single file or directory row with icon, name, size, and selection state */
export function FileEntry({
  entry,
  entryPath,
  isSelected,
  formatSize = formatFileSize,
  className,
  ...props
}: FileEntryProps) {
  return (
    <button
      type="button"
      data-slot="file-entry"
      className={cn(
        "flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-muted/50 border-b last:border-b-0 transition-colors",
        isSelected && "bg-muted",
        className,
      )}
      {...props}
    >
      {entry.is_directory ? (
        <FolderIcon className="h-5 w-5 text-blue-500 shrink-0" />
      ) : (
        <FileIcon className="h-5 w-5 text-muted-foreground shrink-0" />
      )}
      <span className="flex-1 truncate text-sm text-foreground">
        {entry.name ?? entryPath.split("/").pop()}
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
  );
}
