{{if .plugins.files -}}
import type { DirectoryEntry, FilePreview } from '@databricks/appkit-ui/react';
import {
  Button,
  DirectoryList,
  FileBreadcrumb,
  FilePreviewPanel,
  NewFolderInput,
} from '@databricks/appkit-ui/react';
import { FolderPlus, Loader2, Upload } from 'lucide-react';
import { fetchOrThrow } from '../../lib/fetch-or-throw';
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';

const DirectoryEntrySchema: z.ZodType<DirectoryEntry> = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  is_directory: z.boolean().optional(),
  file_size: z.number().optional(),
  last_modified: z.string().optional(),
});

const FilePreviewSchema: z.ZodType<FilePreview> = z.object({
  contentLength: z.number().or(z.undefined()),
  contentType: z.string().or(z.undefined()),
  lastModified: z.string().or(z.undefined()),
  textPreview: z.string().nullable(),
  isText: z.boolean(),
  isImage: z.boolean(),
});

// The files plugin sends `{ error }` in its JSON error responses.
const ServerError = z.object({ error: z.string() });

function useAbortController(): RefObject<AbortController | null> {
  const ref = useRef<AbortController | null>(null);
  return ref;
}

function nextSignal(ref: RefObject<AbortController | null>): AbortSignal {
  ref.current?.abort();
  ref.current = new AbortController();
  return ref.current.signal;
}

const serverErrorOr =
  (fallback: (res: Response) => string) => async (res: Response) => {
    const body = ServerError.safeParse(await res.json().catch(() => null));
    return body.success ? body.data.error : fallback(res);
  };

const isAbort = (err: unknown) =>
  err instanceof DOMException && err.name === 'AbortError';

export function FilesPage() {
  const [volumes, setVolumes] = useState<string[]>([]);
  const [volumeKey, setVolumeKey] = useState<string>(
    () => localStorage.getItem('appkit:files:volumeKey') ?? '',
  );
  const [currentPath, setCurrentPath] = useState<string>('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [showNewDirInput, setShowNewDirInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listAbort = useAbortController();
  const previewAbort = useAbortController();

  const normalize = (p: string) => p.replace(/\/+$/, '');
  const isAtRoot = !currentPath;

  const apiUrl = (action: string, params?: Record<string, string>) => {
    const base = `/api/files/${volumeKey}/${action}`;
    if (!params) return base;
    const qs = new URLSearchParams(params).toString();
    return `${base}?${qs}`;
  };

  const loadDirectory = async (path: string) => {
    if (!volumeKey) return;
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setPreview(null);
    const url = path ? apiUrl('list', { path }) : apiUrl('list');

    try {
      const signal = nextSignal(listAbort);
      const response = await fetchOrThrow(
        url,
        { signal },
        serverErrorOr((res) => `HTTP ${res.status}: ${res.statusText}`),
      );
      const data = z.array(DirectoryEntrySchema).parse(await response.json());
      data.sort((a, b) => {
        if (a.is_directory && !b.is_directory) return -1;
        if (!a.is_directory && b.is_directory) return 1;
        return (a.name ?? '').localeCompare(b.name ?? '');
      });
      setEntries(data);
      setCurrentPath(path);
    } catch (err) {
      if (!isAbort(err)) {
        setError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      }
    }
    setLoading(false);
  };

  const loadPreview = async (filePath: string) => {
    setPreviewLoading(true);
    setPreview(null);

    try {
      const signal = nextSignal(previewAbort);
      const response = await fetchOrThrow(
        apiUrl('preview', { path: filePath }),
        { signal },
        serverErrorOr((res) => `HTTP ${res.status}`),
      );
      setPreview(FilePreviewSchema.parse(await response.json()));
    } catch (err) {
      if (!isAbort(err)) setPreview(null);
    }
    setPreviewLoading(false);
  };

  useEffect(() => {
    fetch('/api/files/volumes')
      .then((res) => res.json())
      .then((data: { volumes: string[] }) => {
        const list = data.volumes ?? [];
        setVolumes(list);
        if (!volumeKey || !list.includes(volumeKey)) {
          const first = list[0];
          if (first) {
            setVolumeKey(first);
            localStorage.setItem('appkit:files:volumeKey', first);
          }
        }
      })
      .catch(() => {});
  }, [volumeKey]);

  // An effect event, so the load reruns only when the volume changes, whether
  // or not the React Compiler memoizes this component.
  const loadRootDirectory = useEffectEvent(() => {
    void loadDirectory('');
  });

  useEffect(() => {
    if (volumeKey) loadRootDirectory();
  }, [volumeKey]);

  const childPath = (name: string) =>
    currentPath ? `${currentPath}/${name}` : name;

  const resolveEntryPath = (entry: DirectoryEntry) =>
    childPath(entry.name ?? '');

  const handleEntryClick = (entry: DirectoryEntry) => {
    const entryPath = resolveEntryPath(entry);
    if (entry.is_directory) {
      void loadDirectory(entryPath);
    } else {
      setSelectedFile(entryPath);
      void loadPreview(entryPath);
    }
  };

  const navigateToParent = () => {
    if (isAtRoot) return;
    const segments = currentPath.split('/').filter(Boolean);
    segments.pop();
    const parentPath = segments.join('/');
    void loadDirectory(parentPath);
  };

  const allSegments = normalize(currentPath).split('/').filter(Boolean);

  const navigateToBreadcrumb = (index: number) => {
    const targetSegments = allSegments.slice(0, index + 1);
    const targetPath = targetSegments.join('/');
    void loadDirectory(targetPath);
  };

  const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_SIZE) {
      setError(
        `File "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum upload size is ${MAX_UPLOAD_SIZE / 1024 / 1024 / 1024} GB.`,
      );
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    try {
      await fetchOrThrow(
        apiUrl('upload', { path: childPath(file.name) }),
        { method: 'POST', body: file },
        serverErrorOr((res) => `Upload failed (${res.status})`),
      );
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setUploading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDelete = async () => {
    if (!selectedFile) return;

    const fileName = selectedFile.split('/').pop();
    if (!window.confirm(`Delete "${fileName}"?`)) return;

    setDeleting(true);
    try {
      await fetchOrThrow(
        `/api/files/${volumeKey}?path=${encodeURIComponent(selectedFile)}`,
        { method: 'DELETE' },
        serverErrorOr((res) => `Delete failed (${res.status})`),
      );
      setSelectedFile(null);
      setPreview(null);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setDeleting(false);
  };

  const handleCreateDirectory = async () => {
    const name = newDirName.trim();
    if (!name) return;

    setCreatingDir(true);
    try {
      await fetchOrThrow(
        apiUrl('mkdir'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: childPath(name) }),
        },
        serverErrorOr((res) => `Create directory failed (${res.status})`),
      );
      setShowNewDirInput(false);
      setNewDirName('');
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setCreatingDir(false);
  };

  return (
    <div className="space-y-6 w-full max-w-7xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Files</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Browse and manage files in Databricks Volumes.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {volumes.length > 1 && (
            <select
              value={volumeKey}
              onChange={(e) => {
                const v = e.target.value;
                setVolumeKey(v);
                localStorage.setItem('appkit:files:volumeKey', v);
                setCurrentPath('');
                setEntries([]);
                setSelectedFile(null);
                setPreview(null);
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
            rootLabel={volumeKey || 'Root'}
            segments={allSegments}
            onNavigateToRoot={() => void loadDirectory('')}
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
            onChange={(e) => void handleUpload(e)}
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
            {uploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-4 md:gap-6">
        <DirectoryList
          className="flex-2 min-w-0"
          entries={entries}
          loading={loading}
          error={error}
          onEntryClick={handleEntryClick}
          onNavigateToParent={navigateToParent}
          onRetry={() => void loadDirectory(currentPath)}
          isAtRoot={isAtRoot}
          selectedPath={selectedFile}
          resolveEntryPath={resolveEntryPath}
          hasCurrentPath={!!currentPath}
          headerContent={
            showNewDirInput ? (
              <NewFolderInput
                value={newDirName}
                onChange={setNewDirName}
                onCreate={() => void handleCreateDirectory()}
                onCancel={() => {
                  setShowNewDirInput(false);
                  setNewDirName('');
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
            window.open(apiUrl('download', { path }), '_blank')
          }
          onDelete={() => void handleDelete()}
          deleting={deleting}
          imagePreviewSrc={(p) => apiUrl('raw', { path: p })}
        />
      </div>
    </div>
  );
}
{{- end}}
