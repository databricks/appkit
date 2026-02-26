import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  Skeleton,
} from "@databricks/appkit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  Download,
  FileIcon,
  FolderIcon,
  FolderPlus,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/files")({
  component: FilesRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

interface DirectoryEntry {
  name?: string;
  path?: string;
  is_directory?: boolean;
  file_size?: number;
  last_modified?: string;
}

interface FilePreview {
  contentLength: number | undefined;
  contentType: string | undefined;
  lastModified: string | undefined;
  textPreview: string | null;
  isText: boolean;
  isImage: boolean;
}

function FilesRoute() {
  const [volumeRoot, setVolumeRoot] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [showNewDirInput, setShowNewDirInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newDirInputRef = useRef<HTMLInputElement>(null);

  const normalize = (p: string) => p.replace(/\/+$/, "");
  const isAtRoot =
    !currentPath || normalize(currentPath) === normalize(volumeRoot);

  const loadDirectory = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setPreview(null);

    try {
      const url = path
        ? `/api/files/list?path=${encodeURIComponent(path)}`
        : "/api/files/list";
      const response = await fetch(url);

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.error ?? `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data: DirectoryEntry[] = await response.json();
      data.sort((a, b) => {
        if (a.is_directory && !b.is_directory) return -1;
        if (!a.is_directory && b.is_directory) return 1;
        return (a.name ?? "").localeCompare(b.name ?? "");
      });
      setEntries(data);
      setCurrentPath(path ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPreview = useCallback(async (filePath: string) => {
    setPreviewLoading(true);
    setPreview(null);

    try {
      const response = await fetch(
        `/api/files/preview?path=${encodeURIComponent(filePath)}`,
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      const data = await response.json();
      setPreview(data);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/files/root")
      .then((res) => res.json())
      .then((data) => {
        const root = data.root ?? "";
        setVolumeRoot(root);
        if (root) {
          loadDirectory(root);
        } else {
          loadDirectory();
        }
      })
      .catch(() => loadDirectory());
  }, [loadDirectory]);

  const resolveEntryPath = (entry: DirectoryEntry) => {
    if (entry.path?.startsWith("/")) return entry.path;
    const name = entry.name ?? "";
    return currentPath ? `${currentPath}/${name}` : name;
  };

  const handleEntryClick = (entry: DirectoryEntry) => {
    const entryPath = resolveEntryPath(entry);
    if (entry.is_directory) {
      loadDirectory(entryPath);
    } else {
      setSelectedFile(entryPath);
      loadPreview(entryPath);
    }
  };

  const navigateToParent = () => {
    if (isAtRoot) return;
    const segments = currentPath.split("/").filter(Boolean);
    segments.pop();
    const parentPath = `/${segments.join("/")}`;
    if (
      volumeRoot &&
      normalize(parentPath).length <= normalize(volumeRoot).length
    ) {
      loadDirectory(volumeRoot);
      return;
    }
    loadDirectory(parentPath);
  };

  const navigateToBreadcrumb = (index: number) => {
    const targetSegments = [
      ...rootSegments,
      ...breadcrumbSegments.slice(0, index + 1),
    ];
    const targetPath = `/${targetSegments.join("/")}`;
    loadDirectory(targetPath);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const uploadPath = currentPath
        ? `${currentPath}/${file.name}`
        : file.name;
      const response = await fetch(
        `/api/files/upload?path=${encodeURIComponent(uploadPath)}`,
        { method: "POST", body: file },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `Upload failed (${response.status})`);
      }

      await loadDirectory(currentPath || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleDelete = async () => {
    if (!selectedFile) return;

    const fileName = selectedFile.split("/").pop();
    if (!window.confirm(`Delete "${fileName}"?`)) return;

    setDeleting(true);
    try {
      const response = await fetch(
        `/api/files/delete?path=${encodeURIComponent(selectedFile)}`,
        { method: "POST" },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `Delete failed (${response.status})`);
      }

      setSelectedFile(null);
      setPreview(null);
      await loadDirectory(currentPath || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const handleCreateDirectory = async () => {
    const name = newDirName.trim();
    if (!name) return;

    setCreatingDir(true);
    try {
      const dirPath = currentPath ? `${currentPath}/${name}` : name;
      const response = await fetch("/api/files/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dirPath }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.error ?? `Create directory failed (${response.status})`,
        );
      }

      setShowNewDirInput(false);
      setNewDirName("");
      await loadDirectory(currentPath || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingDir(false);
    }
  };

  const rootSegments = normalize(volumeRoot).split("/").filter(Boolean);
  const allSegments = normalize(currentPath).split("/").filter(Boolean);
  const breadcrumbSegments = allSegments.slice(rootSegments.length);

  const formatFileSize = (bytes: number | undefined) => {
    if (bytes === undefined || bytes === null) return "Unknown";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <Header
          title="File Browser"
          description="Browse and preview files in Databricks Volumes."
          tooltip="Uses the Files plugin to interact with Databricks Volumes via the Unity Catalog Files API"
        />

        <div className="mb-6 flex items-center justify-between">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                {breadcrumbSegments.length > 0 ? (
                  <BreadcrumbLink
                    className="cursor-pointer"
                    onClick={() => loadDirectory(volumeRoot || undefined)}
                  >
                    {rootSegments.at(-1) ?? "Root"}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>
                    {rootSegments.at(-1) ?? "Root"}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {breadcrumbSegments.map((segment, index) => (
                <span key={segment} className="contents">
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {index === breadcrumbSegments.length - 1 ? (
                      <BreadcrumbPage>{segment}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        className="cursor-pointer"
                        onClick={() => navigateToBreadcrumb(index)}
                      >
                        {segment}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </span>
              ))}
            </BreadcrumbList>
          </Breadcrumb>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowNewDirInput(true);
                setTimeout(() => newDirInputRef.current?.focus(), 0);
              }}
            >
              <FolderPlus className="h-4 w-4 mr-2" />
              New Folder
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleUpload}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </div>
        </div>

        <div className="flex gap-6">
          <div className="flex-2 min-w-0">
            <Card className="p-0 overflow-hidden">
              {!isAtRoot && (
                <button
                  type="button"
                  onClick={navigateToParent}
                  className="flex items-center gap-2 px-4 py-3 w-full text-left hover:bg-muted/50 border-b text-sm text-muted-foreground transition-colors"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to parent
                </button>
              )}

              {showNewDirInput && (
                <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
                  <FolderPlus className="h-5 w-5 text-blue-500 shrink-0" />
                  <input
                    ref={newDirInputRef}
                    type="text"
                    value={newDirName}
                    onChange={(e) => setNewDirName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateDirectory();
                      if (e.key === "Escape") {
                        setShowNewDirInput(false);
                        setNewDirName("");
                      }
                    }}
                    placeholder="Folder name"
                    className="flex-1 text-sm bg-background border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
                    disabled={creatingDir}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={creatingDir || !newDirName.trim()}
                    onClick={handleCreateDirectory}
                  >
                    {creatingDir ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Create"
                    )}
                  </Button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNewDirInput(false);
                      setNewDirName("");
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}

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
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => loadDirectory(currentPath || undefined)}
                  >
                    Retry
                  </Button>
                </div>
              )}

              {!loading && !error && entries.length === 0 && (
                <div className="p-6 text-center text-muted-foreground">
                  <FileIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {currentPath
                      ? "This directory is empty."
                      : "No default volume configured. Set DATABRICKS_DEFAULT_VOLUME to get started."}
                  </p>
                </div>
              )}

              {!loading &&
                !error &&
                entries.map((entry) => {
                  const entryPath = resolveEntryPath(entry);
                  const isSelected = selectedFile === entryPath;

                  return (
                    <button
                      key={entryPath}
                      type="button"
                      onClick={() => handleEntryClick(entry)}
                      className={`flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-muted/50 border-b last:border-b-0 transition-colors ${
                        isSelected ? "bg-muted" : ""
                      }`}
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
                          {formatFileSize(entry.file_size)}
                        </span>
                      )}
                    </button>
                  );
                })}
            </Card>
          </div>

          {/* Preview panel */}
          <div className="flex-1 min-w-0">
            <Card className="p-6">
              {!selectedFile && (
                <div className="text-center text-muted-foreground py-8">
                  <FileIcon className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">Select a file to preview</p>
                </div>
              )}

              {selectedFile && previewLoading && (
                <div className="space-y-3">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-32 w-full mt-4" />
                </div>
              )}

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
                      <span className="text-muted-foreground">Size</span>
                      <span className="text-foreground">
                        {formatFileSize(preview.contentLength)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Type</span>
                      <span className="text-foreground truncate ml-2">
                        {preview.contentType ?? "Unknown"}
                      </span>
                    </div>
                    {preview.lastModified && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Modified</span>
                        <span className="text-foreground">
                          {preview.lastModified}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() =>
                        window.open(
                          `/api/files/download?path=${encodeURIComponent(selectedFile)}`,
                          "_blank",
                        )
                      }
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deleting}
                      onClick={handleDelete}
                    >
                      {deleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>

                  {preview.isImage && (
                    <div className="border rounded overflow-hidden">
                      <img
                        src={`/api/files/raw?path=${encodeURIComponent(selectedFile)}`}
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
                      Preview not available for this file type.
                    </div>
                  )}
                </div>
              )}

              {selectedFile && !previewLoading && !preview && (
                <div className="text-center py-8">
                  <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
                  <p className="text-sm text-destructive">
                    Failed to load preview
                  </p>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
