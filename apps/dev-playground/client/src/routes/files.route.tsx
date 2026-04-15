import type { DirectoryEntry, FilePreview } from "@databricks/appkit-ui/react";
import {
  Button,
  DirectoryList,
  FileBreadcrumb,
  FilePreviewPanel,
  NewFolderInput,
  usePluginClientConfig,
} from "@databricks/appkit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { Check, Download, FolderPlus, Loader2, Upload, X } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Header } from "@/components/layout/header";
import { saveBulkDownloadResponse } from "@/lib/parse-bulk-download-response";

function useAbortController(): RefObject<AbortController | null> {
  const ref = useRef<AbortController | null>(null);
  return ref;
}

function nextSignal(ref: RefObject<AbortController | null>): AbortSignal {
  ref.current?.abort();
  ref.current = new AbortController();
  return ref.current.signal;
}

export const Route = createFileRoute("/files")({
  component: FilesRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

interface FilesClientConfig {
  volumes?: string[];
}

const EMPTY_VOLUMES: readonly string[] = Object.freeze([]);

function FilesRoute() {
  const { volumes = EMPTY_VOLUMES } =
    usePluginClientConfig<FilesClientConfig>("files");
  const [volumeKey, setVolumeKey] = useState<string>(
    () => localStorage.getItem("appkit:files:volumeKey") ?? "",
  );
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
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResults, setBulkResults] = useState<
    | {
        path: string;
        success: boolean;
        error?: string;
        bytesWritten?: number;
      }[]
    | null
  >(null);
  const [selectedBulkPaths, setSelectedBulkPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkDownloadResults, setBulkDownloadResults] = useState<
    | {
        path: string;
        success: boolean;
        error?: string;
        bytesWritten?: number;
      }[]
    | null
  >(null);
  const listAbort = useAbortController();
  const previewAbort = useAbortController();

  const normalize = (p: string) => p.replace(/\/+$/, "");
  const isAtRoot = !currentPath;

  /** Build a volume-scoped API URL. */
  const apiUrl = useCallback(
    (action: string, params?: Record<string, string>) => {
      const base = `/api/files/${volumeKey}/${action}`;
      if (!params) return base;
      const qs = new URLSearchParams(params).toString();
      return `${base}?${qs}`;
    },
    [volumeKey],
  );

  const loadDirectory = useCallback(
    async (path?: string) => {
      if (!volumeKey) return;
      setLoading(true);
      setError(null);
      setSelectedFile(null);
      setPreview(null);

      try {
        const signal = nextSignal(listAbort);
        const url = path ? apiUrl("list", { path }) : apiUrl("list");
        const response = await fetch(url, { signal });

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
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [volumeKey, apiUrl, listAbort],
  );

  const loadPreview = useCallback(
    async (filePath: string) => {
      setPreviewLoading(true);
      setPreview(null);

      try {
        const signal = nextSignal(previewAbort);
        const response = await fetch(apiUrl("preview", { path: filePath }), {
          signal,
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        const data = await response.json();
        setPreview(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    },
    [apiUrl, previewAbort],
  );

  useEffect(() => {
    if (!volumeKey || !volumes.includes(volumeKey)) {
      const first = volumes[0];
      if (first) {
        setVolumeKey(first);
        localStorage.setItem("appkit:files:volumeKey", first);
      }
    }
  }, [volumeKey, volumes]);

  // Load root directory when volume key is set
  useEffect(() => {
    if (volumeKey) {
      loadDirectory();
    }
  }, [volumeKey, loadDirectory]);

  const resolveEntryPath = useCallback(
    (entry: DirectoryEntry) => {
      const name = entry.name ?? "";
      return currentPath ? `${currentPath}/${name}` : name;
    },
    [currentPath],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset bulk selection when volume or folder changes
  useEffect(() => {
    setSelectedBulkPaths(new Set());
  }, [volumeKey, currentPath]);

  useEffect(() => {
    const valid = new Set(entries.map((e) => resolveEntryPath(e)));
    setSelectedBulkPaths((prev) => {
      const next = new Set<string>();
      for (const p of prev) {
        if (valid.has(p)) next.add(p);
      }
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [entries, resolveEntryPath]);

  const onToggleBulkFile = useCallback((path: string, selected: boolean) => {
    setSelectedBulkPaths((prev) => {
      const next = new Set(prev);
      if (selected) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const onSelectAllFilesInList = useCallback(
    (select: boolean) => {
      const filePaths = entries
        .filter((e) => !e.is_directory)
        .map((e) => resolveEntryPath(e));
      setSelectedBulkPaths((prev) => {
        const next = new Set(prev);
        if (select) {
          for (const p of filePaths) next.add(p);
        } else {
          for (const p of filePaths) next.delete(p);
        }
        return next;
      });
    },
    [entries, resolveEntryPath],
  );

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
    const parentPath = segments.join("/");
    loadDirectory(parentPath || undefined);
  };

  const allSegments = normalize(currentPath).split("/").filter(Boolean);

  const navigateToBreadcrumb = (index: number) => {
    const targetSegments = allSegments.slice(0, index + 1);
    const targetPath = targetSegments.join("/");
    loadDirectory(targetPath);
  };

  const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_SIZE) {
      setError(
        `File "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum upload size is ${MAX_UPLOAD_SIZE / 1024 / 1024 / 1024} GB.`,
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setUploading(true);
    try {
      const uploadPath = currentPath
        ? `${currentPath}/${file.name}`
        : file.name;
      const response = await fetch(apiUrl("upload", { path: uploadPath }), {
        method: "POST",
        body: file,
      });

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
        `/api/files/${volumeKey}?path=${encodeURIComponent(selectedFile)}`,
        { method: "DELETE" },
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
      const response = await fetch(apiUrl("mkdir"), {
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

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const oversized = Array.from(fileList).find(
      (f) => f.size > MAX_UPLOAD_SIZE,
    );
    if (oversized) {
      setError(
        `File "${oversized.name}" is too large (${(oversized.size / 1024 / 1024).toFixed(1)} MB). Maximum per-file size is ${MAX_UPLOAD_SIZE / 1024 / 1024 / 1024} GB.`,
      );
      if (bulkFileInputRef.current) bulkFileInputRef.current.value = "";
      return;
    }

    setBulkUploading(true);
    setBulkResults(null);
    setError(null);

    try {
      const formData = new FormData();
      for (const file of Array.from(fileList)) {
        const uploadPath = currentPath
          ? `${currentPath}/${file.name}`
          : file.name;
        formData.append(uploadPath, file, uploadPath);
      }

      const response = await fetch(apiUrl("bulk-upload"), {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.error ?? `Bulk upload failed (${response.status})`,
        );
      }

      const data = await response.json();
      setBulkResults(data.results);
      await loadDirectory(currentPath || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkUploading(false);
      if (bulkFileInputRef.current) {
        bulkFileInputRef.current.value = "";
      }
    }
  };

  const handleBulkDownload = async () => {
    if (selectedBulkPaths.size === 0 || !volumeKey) return;

    setBulkDownloading(true);
    setBulkDownloadResults(null);
    setError(null);

    try {
      const response = await fetch(`/api/files/${volumeKey}/bulk-download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...selectedBulkPaths] }),
      });
      const summary = await saveBulkDownloadResponse(response);
      setBulkDownloadResults(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkDownloading(false);
    }
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
          <div className="flex items-center gap-3">
            {volumes.length > 1 && (
              <select
                value={volumeKey}
                onChange={(e) => {
                  const v = e.target.value;
                  setVolumeKey(v);
                  localStorage.setItem("appkit:files:volumeKey", v);
                  setCurrentPath("");
                  setEntries([]);
                  setSelectedFile(null);
                  setPreview(null);
                  setSelectedBulkPaths(new Set());
                }}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              >
                {volumes.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
            <FileBreadcrumb
              rootLabel={volumeKey || "Root"}
              segments={allSegments}
              onNavigateToRoot={() => loadDirectory()}
              onNavigateToSegment={navigateToBreadcrumb}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowNewDirInput(true)}
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
            <input
              ref={bulkFileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleBulkUpload}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={bulkUploading}
              onClick={() => bulkFileInputRef.current?.click()}
            >
              {bulkUploading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              {bulkUploading ? "Uploading..." : "Bulk Upload"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                bulkDownloading || selectedBulkPaths.size === 0 || !volumeKey
              }
              onClick={handleBulkDownload}
            >
              {bulkDownloading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              {bulkDownloading ? "Downloading..." : "Download selected"}
            </Button>
          </div>
        </div>

        {bulkResults && (
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">
                Bulk Upload Results —{" "}
                {bulkResults.filter((r) => r.success).length}/
                {bulkResults.length} succeeded
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBulkResults(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <ul className="space-y-1 text-sm max-h-48 overflow-y-auto">
              {bulkResults.map((r) => (
                <li key={r.path} className="flex items-center gap-2">
                  {r.success ? (
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-500 shrink-0" />
                  )}
                  <span className="truncate">{r.path.split("/").pop()}</span>
                  {r.success && r.bytesWritten != null && (
                    <span className="text-muted-foreground ml-auto shrink-0">
                      {r.bytesWritten > 1024
                        ? `${(r.bytesWritten / 1024).toFixed(1)} KB`
                        : `${r.bytesWritten} B`}
                    </span>
                  )}
                  {r.error && (
                    <span className="text-red-500 ml-auto truncate shrink-0 max-w-[50%]">
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {bulkDownloadResults && (
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">
                Bulk Download Results —{" "}
                {bulkDownloadResults.filter((r) => r.success).length}/
                {bulkDownloadResults.length} succeeded
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBulkDownloadResults(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <ul className="space-y-1 text-sm max-h-48 overflow-y-auto">
              {bulkDownloadResults.map((r) => (
                <li key={r.path} className="flex items-center gap-2">
                  {r.success ? (
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-500 shrink-0" />
                  )}
                  <span className="truncate">{r.path.split("/").pop()}</span>
                  {r.success && r.bytesWritten != null && (
                    <span className="text-muted-foreground ml-auto shrink-0">
                      {r.bytesWritten > 1024
                        ? `${(r.bytesWritten / 1024).toFixed(1)} KB`
                        : `${r.bytesWritten} B`}
                    </span>
                  )}
                  {r.error && (
                    <span className="text-red-500 ml-auto truncate shrink-0 max-w-[50%]">
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-6">
          <DirectoryList
            className="flex-2 min-w-0"
            entries={entries}
            loading={loading}
            error={error}
            onEntryClick={handleEntryClick}
            onNavigateToParent={navigateToParent}
            onRetry={() => loadDirectory(currentPath || undefined)}
            isAtRoot={isAtRoot}
            selectedPath={selectedFile}
            resolveEntryPath={resolveEntryPath}
            hasCurrentPath={!!currentPath}
            enableFileSelection
            selectedFilePaths={selectedBulkPaths}
            onToggleFile={onToggleBulkFile}
            onSelectAllFiles={onSelectAllFilesInList}
            headerContent={
              showNewDirInput ? (
                <NewFolderInput
                  value={newDirName}
                  onChange={setNewDirName}
                  onCreate={handleCreateDirectory}
                  onCancel={() => {
                    setShowNewDirInput(false);
                    setNewDirName("");
                  }}
                  creating={creatingDir}
                />
              ) : undefined
            }
          />

          <FilePreviewPanel
            className="flex-1 min-w-0"
            selectedFile={selectedFile}
            preview={preview}
            previewLoading={previewLoading}
            onDownload={(path) =>
              window.open(apiUrl("download", { path }), "_blank")
            }
            onDelete={handleDelete}
            deleting={deleting}
            imagePreviewSrc={(p) => apiUrl("raw", { path: p })}
          />
        </div>
      </div>
    </div>
  );
}
