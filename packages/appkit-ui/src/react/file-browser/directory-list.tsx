import { AlertCircle, ArrowLeft, FileIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { FileEntry } from "./file-entry";
import type { DirectoryEntry, FileBrowserLabels } from "./types";

/** Props for the DirectoryList component */
export interface DirectoryListProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** Directory entries to display */
  entries: DirectoryEntry[];
  /** Whether the directory is currently loading */
  loading?: boolean;
  /** Error message to display */
  error?: string | null;
  /** Called when an entry is clicked */
  onEntryClick: (entry: DirectoryEntry) => void;
  /** Called when the back/parent button is clicked */
  onNavigateToParent?: () => void;
  /** Called when the retry button is clicked */
  onRetry?: () => void;
  /** Whether the user is at the root directory (hides back button) */
  isAtRoot?: boolean;
  /** Currently selected file path for highlighting */
  selectedPath?: string | null;
  /** Resolves a DirectoryEntry to its full path */
  resolveEntryPath: (entry: DirectoryEntry) => string;
  /** Content rendered between the back button and the entry list (e.g., NewFolderInput) */
  headerContent?: React.ReactNode;
  /** Whether a current path is set (affects empty state message) */
  hasCurrentPath?: boolean;
  /** Custom file size formatter */
  formatSize?: (bytes: number | undefined) => string;
  /** Customizable labels */
  labels?: Pick<
    FileBrowserLabels,
    "backToParent" | "emptyDirectory" | "noVolumeConfigured" | "retry"
  >;
}

/** Card-wrapped directory listing with loading, error, and empty states */
export function DirectoryList({
  entries,
  loading,
  error,
  onEntryClick,
  onNavigateToParent,
  onRetry,
  isAtRoot,
  selectedPath,
  resolveEntryPath,
  headerContent,
  hasCurrentPath,
  formatSize,
  labels,
  className,
  ...props
}: DirectoryListProps) {
  return (
    <div data-slot="directory-list" className={className} {...props}>
      <Card className="p-0 overflow-hidden">
        {!isAtRoot && onNavigateToParent && (
          <button
            type="button"
            onClick={onNavigateToParent}
            className="flex items-center gap-2 px-4 py-3 w-full text-left hover:bg-muted/50 border-b text-sm text-muted-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            {labels?.backToParent ?? "Back to parent"}
          </button>
        )}

        {headerContent}

        {loading && (
          <div className="p-4 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {error && (
          <div className="p-6 text-center">
            <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
            <p className="text-sm text-destructive">{error}</p>
            {onRetry && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={onRetry}
              >
                {labels?.retry ?? "Retry"}
              </Button>
            )}
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="p-6 text-center text-muted-foreground">
            <FileIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">
              {hasCurrentPath
                ? (labels?.emptyDirectory ?? "This directory is empty.")
                : (labels?.noVolumeConfigured ??
                  "No volume configured. Configure volumes in the files plugin to get started.")}
            </p>
          </div>
        )}

        {!loading &&
          !error &&
          entries.map((entry) => {
            const entryPath = resolveEntryPath(entry);
            return (
              <FileEntry
                key={entryPath}
                entry={entry}
                entryPath={entryPath}
                isSelected={selectedPath === entryPath}
                formatSize={formatSize}
                onClick={() => onEntryClick(entry)}
              />
            );
          })}
      </Card>
    </div>
  );
}
