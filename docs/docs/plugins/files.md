---
sidebar_position: 6
---

# Files plugin

File operations against Databricks Unity Catalog Volumes. Supports listing, reading, downloading, uploading, deleting, and previewing files with built-in caching, retry, and timeout handling via the execution interceptor pipeline.

**Key features:**
- **Multi-volume**: Define named volumes (e.g. `uploads`, `exports`) and access them independently
- CRUD operations on Unity Catalog Volume files
- Streaming downloads with content-type resolution
- Inline raw serving with XSS-safe content type enforcement
- Upload size limits with streaming enforcement
- Automatic cache invalidation on write operations
- Custom content type mappings
- Per-user execution context (OBO)

## Basic usage

```ts
import { createApp, files, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    files(),
  ],
});
```

Set `DATABRICKS_VOLUME_*` environment variables in your `app.yaml` (or `.env`). The plugin auto-discovers them at startup:

```bash
DATABRICKS_VOLUME_UPLOADS=/Volumes/catalog/schema/uploads
DATABRICKS_VOLUME_EXPORTS=/Volumes/catalog/schema/exports
```

That's it — no `volumes` config needed. The env var suffix becomes the volume key (lowercased):

| Environment variable         | Volume key |
| ---------------------------- | ---------- |
| `DATABRICKS_VOLUME_UPLOADS`  | `uploads`  |
| `DATABRICKS_VOLUME_EXPORTS`  | `exports`  |

## Auto-discovery

The plugin scans `process.env` for keys matching `DATABRICKS_VOLUME_*` and registers each as a volume with default `{}` config. Env vars with an empty value or the bare `DATABRICKS_VOLUME_` prefix (no suffix) are skipped.

**Merge semantics:** auto-discovered volumes are always merged with explicitly configured ones. Explicit config wins for per-volume overrides (e.g., `maxUploadSize`), while discovered-only volumes get default settings.

```ts
// Explicit overrides for uploads; exports is auto-discovered from env
files({
  volumes: {
    uploads: { maxUploadSize: 100_000_000 },
  },
});
```

This produces two volumes (`uploads` with a 100 MB limit, `exports` with defaults), assuming both `DATABRICKS_VOLUME_UPLOADS` and `DATABRICKS_VOLUME_EXPORTS` are set.

## Configuration

```ts
interface IFilesConfig {
  /** Named volumes to expose. Each key becomes a volume accessor. */
  volumes?: Record<string, VolumeConfig>;
  /** Operation timeout in milliseconds. Overrides the per-tier defaults. */
  timeout?: number;
  /** Map of file extensions to MIME types (priority over built-in map). Inherited by all volumes. */
  customContentTypes?: Record<string, string>;
  /** Maximum upload size in bytes. Defaults to 5 GB. Inherited by all volumes. */
  maxUploadSize?: number;
}

interface VolumeConfig {
  /** Maximum upload size in bytes for this volume. Overrides plugin-level default. */
  maxUploadSize?: number;
  /** Map of file extensions to MIME types for this volume. Overrides plugin-level default. */
  customContentTypes?: Record<string, string>;
}
```

### Per-volume overrides

Each volume inherits the plugin-level `maxUploadSize` and `customContentTypes` unless overridden:

```ts
files({
  maxUploadSize: 5_000_000_000, // 5 GB default for all volumes
  customContentTypes: { ".avro": "application/avro" },
  volumes: {
    uploads: { maxUploadSize: 100_000_000 }, // 100 MB limit for uploads only
    exports: {},                              // uses plugin-level defaults
  },
});
```

### Custom content types

Override or extend the built-in extension → MIME map:

```ts
files({
  volumes: { data: {} },
  customContentTypes: {
    ".avro": "application/avro",
    ".ndjson": "application/x-ndjson",
  },
});
```

Dangerous MIME types (`text/html`, `text/javascript`, `application/javascript`, `application/xhtml+xml`, `image/svg+xml`) are blocked to prevent stored-XSS when files are served inline via `/raw`.

## HTTP routes

Routes are mounted at `/api/files/*`. All routes except `/volumes` execute in user context via `asUser(req)`.

| Method | Path                       | Query / Body                 | Response                                          |
| ------ | -------------------------- | ---------------------------- | ------------------------------------------------- |
| GET    | `/volumes`                 | —                            | `{ volumes: string[] }`                           |
| GET    | `/:volumeKey/list`         | `?path` (optional)           | `DirectoryEntry[]`                                |
| GET    | `/:volumeKey/read`         | `?path` (required)           | `text/plain` body                                 |
| GET    | `/:volumeKey/download`     | `?path` (required)           | Binary stream (`Content-Disposition: attachment`)  |
| GET    | `/:volumeKey/raw`          | `?path` (required)           | Binary stream (inline for safe types, attachment for unsafe) |
| GET    | `/:volumeKey/exists`       | `?path` (required)           | `{ exists: boolean }`                             |
| GET    | `/:volumeKey/metadata`     | `?path` (required)           | `FileMetadata`                                    |
| GET    | `/:volumeKey/preview`      | `?path` (required)           | `FilePreview`                                     |
| POST   | `/:volumeKey/upload`       | `?path` (required), raw body | `{ success: true }`                               |
| POST   | `/:volumeKey/mkdir`        | `body.path` (required)       | `{ success: true }`                               |
| DELETE | `/:volumeKey`              | `?path` (required)           | `{ success: true }`                               |

The `:volumeKey` parameter must match one of the configured volume keys. Unknown volume keys return a `404` with the list of available volumes.

### Path validation

All endpoints that accept a `path` parameter enforce:
- Path is required (non-empty)
- Maximum 4096 characters
- No null bytes

### Raw endpoint security

The `/:volumeKey/raw` endpoint serves files inline for browser display but applies security headers:
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: sandbox`
- Unsafe content types (HTML, JS, SVG) are forced to download via `Content-Disposition: attachment`

## Execution defaults

Every operation runs through the interceptor pipeline with tier-specific defaults:

| Tier         | Cache | Retry | Timeout | Operations                            |
| ------------ | ----- | ----- | ------- | ------------------------------------- |
| **Read**     | 60 s  | 3x    | 30 s    | list, read, exists, metadata, preview |
| **Download** | none  | 3x    | 30 s    | download, raw                         |
| **Write**    | none  | none  | 600 s   | upload, mkdir, delete                 |

Retry uses exponential backoff with a 1 s initial delay.

The download timeout applies to the stream start, not the full transfer.

## Cache isolation

Cache keys include the volume key, ensuring volumes have independent caches. For example, `uploads:list` and `exports:list` are cached separately.

Write operations (`upload`, `mkdir`, `delete`) automatically invalidate the cached `list` entry for the parent directory of the affected volume.

## Programmatic API

The `exports()` API is a callable that accepts a volume key and returns a `VolumeHandle`. The handle exposes all `VolumeAPI` methods directly (service principal, logs a warning) and an `asUser(req)` method for OBO access (recommended).

```ts
// OBO access (recommended)
const entries = await appkit.files("uploads").asUser(req).list();
const content = await appkit.files("exports").asUser(req).read("report.csv");

// Service principal access (logs a warning encouraging OBO)
const entries = await appkit.files("uploads").list();

// Named accessor
const vol = appkit.files.volume("uploads");
await vol.asUser(req).list();
```

### VolumeAPI methods

| Method            | Signature                                                                                          | Returns            |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------ |
| `list`            | `(directoryPath?: string)`                                                                         | `DirectoryEntry[]` |
| `read`            | `(filePath: string, options?: { maxSize?: number })`                                               | `string`           |
| `download`        | `(filePath: string)`                                                                               | `DownloadResponse` |
| `exists`          | `(filePath: string)`                                                                               | `boolean`          |
| `metadata`        | `(filePath: string)`                                                                               | `FileMetadata`     |
| `upload`          | `(filePath: string, contents: ReadableStream \| Buffer \| string, options?: { overwrite?: boolean })` | `void`          |
| `createDirectory` | `(directoryPath: string)`                                                                          | `void`             |
| `delete`          | `(filePath: string)`                                                                               | `void`             |
| `preview`         | `(filePath: string)`                                                                               | `FilePreview`      |

> `read()` loads the entire file into memory as a string. Files larger than 10 MB (default) are rejected — use `download()` for large files, or pass `{ maxSize: <bytes> }` to override.

## Path resolution

Paths can be **absolute** or **relative**:

- **Absolute** — starts with `/`, must begin with `/Volumes/` (e.g. `/Volumes/catalog/schema/vol/data.csv`)
- **Relative** — prepended with the volume path resolved from the environment variable (e.g. `data.csv` → `/Volumes/catalog/schema/uploads/data.csv`)

Path traversal (`../`) is rejected. If a relative path is used and the volume's environment variable is not set, an error is thrown.

The `list()` method with no arguments lists the volume root.

## Types

```ts
// Re-exported from @databricks/sdk-experimental
type DirectoryEntry = files.DirectoryEntry;
type DownloadResponse = files.DownloadResponse;

interface FileMetadata {
  /** File size in bytes. */
  contentLength: number | undefined;
  /** MIME content type of the file. */
  contentType: string | undefined;
  /** ISO 8601 timestamp of the last modification. */
  lastModified: string | undefined;
}

interface FilePreview extends FileMetadata {
  /** First portion of text content, or null for non-text files. */
  textPreview: string | null;
  /** Whether the file is detected as a text format. */
  isText: boolean;
  /** Whether the file is detected as an image format. */
  isImage: boolean;
}

interface VolumeConfig {
  /** Maximum upload size in bytes for this volume. */
  maxUploadSize?: number;
  /** Map of file extensions to MIME types for this volume. */
  customContentTypes?: Record<string, string>;
}

interface VolumeAPI {
  list(directoryPath?: string): Promise<DirectoryEntry[]>;
  read(filePath: string, options?: { maxSize?: number }): Promise<string>;
  download(filePath: string): Promise<DownloadResponse>;
  exists(filePath: string): Promise<boolean>;
  metadata(filePath: string): Promise<FileMetadata>;
  upload(filePath: string, contents: ReadableStream | Buffer | string, options?: { overwrite?: boolean }): Promise<void>;
  createDirectory(directoryPath: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  preview(filePath: string): Promise<FilePreview>;
}

/** Volume handle: all VolumeAPI methods (service principal) + asUser() for OBO. */
type VolumeHandle = VolumeAPI & {
  asUser: (req: Request) => VolumeAPI;
};
```

## Content-type resolution

`contentTypeFromPath(filePath, reported?, customTypes?)` resolves a file's MIME type:

1. Check `customContentTypes` map first (if configured).
2. Match the file extension against the built-in map.
3. Fall back to the server-reported type, or `application/octet-stream`.

Built-in extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`, `.html`, `.css`, `.js`, `.ts`, `.py`, `.txt`, `.md`, `.csv`, `.json`, `.jsonl`, `.xml`, `.yaml`, `.yml`, `.sql`, `.pdf`, `.ipynb`, `.parquet`, `.zip`, `.gz`.

## User context

Routes use `this.asUser(req)` so operations execute with the requesting user's Databricks credentials (on-behalf-of / OBO). The `/volumes` route is the only exception since it only reads plugin config.

The programmatic API returns a `VolumeHandle` that exposes all `VolumeAPI` methods directly (service principal) and an `asUser(req)` method for OBO access. Calling any method without `asUser()` logs a warning encouraging OBO usage but does not throw. OBO access is strongly recommended for production use.

## Resource requirements

Volume resources are declared **dynamically** via `getResourceRequirements(config)` based on discovered + configured volumes. Each volume key generates a required resource with `WRITE_VOLUME` permission and a `DATABRICKS_VOLUME_{KEY_UPPERCASE}` environment variable.

For example, if `DATABRICKS_VOLUME_UPLOADS` and `DATABRICKS_VOLUME_EXPORTS` are set, calling `files()` generates two required volume resources validated at startup — no explicit `volumes` config needed.

## Error responses

All errors return JSON:

```json
{
  "error": "Human-readable message",
  "plugin": "files"
}
```

| Status | Description                                                    |
| ------ | -------------------------------------------------------------- |
| 400    | Missing or invalid `path` parameter                            |
| 404    | Unknown volume key                                             |
| 413    | Upload exceeds `maxUploadSize`                                 |
| 500    | Operation failed (SDK, network, upstream, or unhandled error)  |

## Frontend components

The `@databricks/appkit-ui` package provides ready-to-use React components for building a file browser:

### FileBrowser

A composable set of components for browsing, previewing, and managing files in a Unity Catalog Volume:

```tsx
import {
  DirectoryList,
  FileBreadcrumb,
  FilePreviewPanel,
} from "@databricks/appkit-ui/react";

function FileBrowserPage() {
  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 1 }}>
        <FileBreadcrumb
          rootLabel="uploads"
          segments={["data"]}
          onNavigateToRoot={() => {}}
          onNavigateToSegment={() => {}}
        />
        <DirectoryList
          entries={[]}
          onEntryClick={() => {}}
          resolveEntryPath={(entry) => entry.path ?? ""}
        />
      </div>
      <FilePreviewPanel selectedFile={null} preview={null} />
    </div>
  );
}
```

See the [Files (UC) components](../api/appkit-ui/files/DirectoryList) reference for the full props API.
