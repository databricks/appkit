import { AlertCircle, Download, FileIcon, Loader2, Trash2 } from "lucide-react";
import { formatFileSize } from "../lib/format";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import type { FileBrowserLabels, FilePreview } from "./types";

/** Props for the FilePreviewPanel component */
export interface FilePreviewPanelProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** Full path of the selected file (null when nothing is selected) */
  selectedFile: string | null;
  /** Preview data for the selected file */
  preview: FilePreview | null;
  /** Whether the preview is loading */
  previewLoading?: boolean;
  /** Called when the download button is clicked */
  onDownload?: (filePath: string) => void;
  /** Called when the delete button is clicked */
  onDelete?: (filePath: string) => void;
  /** Whether a delete operation is in progress */
  deleting?: boolean;
  /** Image preview source — string URL or function that receives the file path */
  imagePreviewSrc?: string | ((filePath: string) => string);
  /** Custom file size formatter (defaults to formatFileSize) */
  formatSize?: (bytes: number | undefined) => string;
  /** Customizable labels */
  labels?: Pick<
    FileBrowserLabels,
    | "selectFilePrompt"
    | "previewNotAvailable"
    | "previewFailed"
    | "download"
    | "size"
    | "type"
    | "modified"
    | "unknown"
  >;
}

/** Preview panel displaying file metadata, image/text preview, and download/delete actions */
export function FilePreviewPanel({
  selectedFile,
  preview,
  previewLoading,
  onDownload,
  onDelete,
  deleting,
  imagePreviewSrc,
  formatSize = formatFileSize,
  labels,
  className,
  ...props
}: FilePreviewPanelProps) {
  const resolveImageSrc = (filePath: string) => {
    if (!imagePreviewSrc) return "";
    if (typeof imagePreviewSrc === "string") return imagePreviewSrc;
    return imagePreviewSrc(filePath);
  };

  return (
    <div data-slot="file-preview-panel" className={className} {...props}>
      <Card className="p-6">
        {/* No file selected */}
        {!selectedFile && (
          <div className="text-center text-muted-foreground py-8">
            <FileIcon className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">
              {labels?.selectFilePrompt ?? "Select a file to preview"}
            </p>
          </div>
        )}

        {/* Loading state */}
        {selectedFile && previewLoading && (
          <div className="space-y-3">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-32 w-full mt-4" />
          </div>
        )}

        {/* Preview content */}
        {selectedFile && !previewLoading && preview && (
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-foreground truncate mb-1">
                {selectedFile.split("/").pop()}
              </h3>
              <p className="text-xs text-muted-foreground truncate">
                {selectedFile}
              </p>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {labels?.size ?? "Size"}
                </span>
                <span className="text-foreground">
                  {formatSize(preview.contentLength)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {labels?.type ?? "Type"}
                </span>
                <span className="text-foreground truncate ml-2">
                  {preview.contentType ?? labels?.unknown ?? "Unknown"}
                </span>
              </div>
              {preview.lastModified && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {labels?.modified ?? "Modified"}
                  </span>
                  <span className="text-foreground">
                    {preview.lastModified}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              {onDownload && (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => onDownload(selectedFile)}
                >
                  <Download className="h-4 w-4 mr-2" />
                  {labels?.download ?? "Download"}
                </Button>
              )}
              {onDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleting}
                  onClick={() => onDelete(selectedFile)}
                >
                  {deleting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>

            {preview.isImage && imagePreviewSrc && (
              <div className="border rounded overflow-hidden">
                <img
                  src={resolveImageSrc(selectedFile)}
                  alt={selectedFile.split("/").pop() ?? "Preview"}
                  className="w-full h-auto"
                />
              </div>
            )}

            {preview.isText && preview.textPreview !== null && (
              <div className="border rounded">
                <pre className="p-3 text-xs font-mono overflow-auto max-h-80 whitespace-pre-wrap text-foreground bg-muted/30">
                  {preview.textPreview}
                </pre>
              </div>
            )}

            {!preview.isText && !preview.isImage && (
              <div className="text-center py-4 text-sm text-muted-foreground">
                {labels?.previewNotAvailable ??
                  "Preview not available for this file type."}
              </div>
            )}
          </div>
        )}

        {/* Preview load failed */}
        {selectedFile && !previewLoading && !preview && (
          <div className="text-center py-8">
            <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
            <p className="text-sm text-destructive">
              {labels?.previewFailed ?? "Failed to load preview"}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
